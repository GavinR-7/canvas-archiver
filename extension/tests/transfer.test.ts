import { describe, expect, it, vi } from "vitest";
import { hashText, emptyManifest, type CourseManifest } from "@/src/files/manifest";
import { archiveLayout } from "@/src/files/layout";
import { planCourse, type PlannedItem } from "@/src/files/plan";
import { runArchive, type FileSink, type ManifestStore } from "@/src/files/runner";
import { acquireCanvasFile, browserDownload, downloadsRelative, scrubUrls, MAX_ATTEMPTS, type TransferDeps } from "@/src/files/transfer";

const item = (url = "https://canvas.cornell.edu/files/9/download?verifier=x"): PlannedItem => ({
  source: "canvas:file/9", courseId: 7, path: ["Cornell", "CS 3700", "Exams", "prelim.pdf"], size: 10, modifiedAt: "t1", url, content: null,
});
const ok = () => new Response("bytes", { status: 200 });
const status = (n: number) => new Response("no", { status: n });

/** A fixture file host: `rules` answers each call by its credentials mode, in order. */
function host(rules: Array<(init: RequestInit) => Response | Error>) {
  const calls: Array<{ url: string; credentials: string | undefined }> = [];
  let n = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, credentials: init.credentials });
    const answer = (rules[Math.min(n++, rules.length - 1)] as (i: RequestInit) => Response | Error)(init);
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const blocked = () => new TypeError("Failed to fetch");
const deps = (fetchFn: typeof fetch, download: TransferDeps["download"] = null): TransferDeps & { slept: number[] } => {
  const slept: number[] = [];
  return { fetch: fetchFn, download, sleep: async (ms) => void slept.push(ms), canvasOrigin: "https://canvas.cornell.edu", slept };
};

describe("acquireCanvasFile", () => {
  it("reads directly without credentials when the host allows it", async () => {
    const h = host([ok]);
    const got = await acquireCanvasFile(item(), deps(h.fetchFn), true);
    expect(got).toMatchObject({ how: "stream", method: "fetch" });
    expect(h.calls.map((c) => c.credentials)).toEqual(["omit"]);
  });

  it("retries 502 and 503 with backoff, then succeeds", async () => {
    const h = host([() => status(502), () => status(503), ok]);
    const d = deps(h.fetchFn);
    expect(await acquireCanvasFile(item(), d, false)).toMatchObject({ method: "fetch" });
    expect(h.calls).toHaveLength(3);
    expect(d.slept).toHaveLength(2);
    expect(d.slept[1] as number).toBeGreaterThan(d.slept[0] as number);
  });

  it("gives up on a gateway error after a bounded number of tries and says the status", async () => {
    const h = host([() => status(502)]);
    await expect(acquireCanvasFile(item(), deps(h.fetchFn), false)).rejects.toThrow("Canvas answered 502");
    // direct tries, then the session tries
    expect(h.calls.length).toBe(2 * MAX_ATTEMPTS);
  });

  it("tries the Canvas session when the verifier is refused", async () => {
    const h = host([(init) => (init.credentials === "omit" ? status(403) : ok())]);
    const got = await acquireCanvasFile(item(), deps(h.fetchFn), false);
    expect(got).toMatchObject({ how: "stream", method: "fetch-session" });
    expect(h.calls.map((c) => c.credentials)).toEqual(["omit", "include"]);
  });

  it("falls back to the browser downloader when the host refuses every direct read, and reports the method", async () => {
    const h = host([blocked]);
    const download = vi.fn(async () => ({ size: 4321, savedTo: "Cornell/CS 3700/Exams/prelim (1).pdf" }));
    const got = await acquireCanvasFile(item(), deps(h.fetchFn, download), true);
    expect(got).toEqual({ how: "downloaded", size: 4321, savedTo: "Cornell/CS 3700/Exams/prelim (1).pdf", method: "downloads" });
    expect(download).toHaveBeenCalledWith("https://canvas.cornell.edu/files/9/download?verifier=x", "Cornell/CS 3700/Exams/prelim.pdf");
  });

  it("never sends the session to a host that is not Canvas, but still falls back", async () => {
    const h = host([blocked]);
    const download = vi.fn(async () => ({ size: 1, savedTo: "x" }));
    const got = await acquireCanvasFile(item("https://files.example.org/x"), deps(h.fetchFn, download), true);
    expect(got.method).toBe("downloads");
    expect(h.calls.every((c) => c.credentials === "omit")).toBe(true);
  });

  it("does not fall back when the caller forbids it (ingest layout); the failure is named, not silent", async () => {
    const download = vi.fn(async () => ({ size: 1, savedTo: "x" }));
    await expect(acquireCanvasFile(item(), deps(host([blocked]).fetchFn, download), false)).rejects.toThrow(/^blocked:/);
    expect(download).not.toHaveBeenCalled();
  });

  it("fails loudly when the downloader fails too, keeping the blocked prefix and no URL", async () => {
    const download = vi.fn(async () => {
      throw new Error("NETWORK_FAILED");
    });
    const error = await acquireCanvasFile(item(), deps(host([blocked]).fetchFn, download), true).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/^blocked: .*NETWORK_FAILED/);
    expect((error as Error).message).not.toContain("verifier");
  });
});

describe("scrubbing and the real downloader", () => {
  it("removes addresses and query strings, keeping the reason", () => {
    const text = scrubUrls("Could not download https://x.cdn.com/f/9?verifier=SECRET&x=1 (NETWORK_FAILED) or /files/9/download?verifier=SECRET2");
    expect(text).not.toMatch(/SECRET/);
    expect(text).toContain("NETWORK_FAILED");
  });

  it("a downloader that rejects with the signed address never leaks it through the outcome", async () => {
    const download = async () => {
      throw new Error("Could not download https://canvas.cornell.edu/files/9/download?verifier=SECRET");
    };
    const error = (await acquireCanvasFile(item(), deps(host([blocked]).fetchFn, download), true).catch((e: Error) => e)) as Error;
    expect(error.message).toMatch(/^blocked:/);
    expect(error.message).not.toContain("SECRET");
  });

  it("maps a Windows Downloads path to the Downloads-relative one", () => {
    expect(downloadsRelative("C:\\Users\\g\\Downloads\\Cornell\\CS 3700\\a (1).pdf", "p")).toBe("Cornell/CS 3700/a (1).pdf");
    expect(downloadsRelative(undefined, "Cornell/a.pdf")).toBe("Cornell/a.pdf");
  });

  it("never overwrites, and erases the history record on success and on failure", async () => {
    const listeners: Array<(d: unknown) => void> = [];
    const erase = vi.fn(async () => []);
    const download = vi.fn(async () => 5);
    const items = [{ id: 5, state: "complete", fileSize: 77, filename: "C:\\u\\Downloads\\Cornell\\a (1).pdf" }];
    vi.stubGlobal("chrome", {
      runtime: {},
      downloads: {
        download,
        erase,
        search: async () => items,
        onChanged: { addListener: (l: (d: unknown) => void) => listeners.push(l), removeListener: () => undefined },
      },
    });
    try {
      const got = await browserDownload(1000)("https://c/x?verifier=SECRET", "Cornell/a.pdf");
      expect(got).toEqual({ size: 77, savedTo: "Cornell/a (1).pdf" });
      expect(download).toHaveBeenCalledWith({ url: "https://c/x?verifier=SECRET", filename: "Cornell/a.pdf", conflictAction: "uniquify" });
      expect(erase).toHaveBeenCalledWith({ id: 5 });

      erase.mockClear();
      items[0] = { id: 5, state: "interrupted", fileSize: 0, filename: "", error: "NETWORK_FAILED https://c/x?verifier=SECRET" } as never;
      const failure = (await browserDownload(1000)("https://c/x?verifier=SECRET", "Cornell/a.pdf").catch((e: Error) => e)) as Error;
      expect(failure.message).not.toContain("SECRET");
      expect(erase).toHaveBeenCalledWith({ id: 5 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("run with a host that refuses direct reads", () => {
  const course = { id: 7, name: "Foundations of AI", courseCode: "CS 3700" };
  const sources = {
    modules: [{ id: 1, name: "Exams", position: 1, fileIds: [1, 2, 3] }],
    files: [1, 2, 3].map((id) => ({ id, displayName: `f${id}.pdf`, filename: `f${id}.pdf`, size: 10, updatedAt: "t1", url: `https://canvas.cornell.edu/files/${id}/download?verifier=x`, folderId: null, locked: false })),
    folders: [],
    documents: [],
  };

  function sinkThatFallsBack() {
    const disk = new Map<string, number>();
    const fetched: string[] = [];
    const sink: FileSink = {
      keepsRecords: true,
      size: async (p) => disk.get(p.join("/")) ?? null,
      readText: async () => null,
      writeText: async () => {},
      save: async (it) => {
        fetched.push(it.source);
        // every file is refused for a direct read: the browser downloads it under Downloads (not in `disk`)
        return { size: 10, sha256: null, method: "downloads", savedTo: `Cornell/${it.path.at(-1)} (1)` };
      },
    };
    return { sink, fetched, disk };
  }
  const data = new Map<number, CourseManifest>();
  const store: ManifestStore = {
    load: async (p) => data.get(p.courseId) ?? emptyManifest(p.courseId),
    save: async (p, m) => void data.set(p.courseId, structuredClone(m)),
  };

  it("counts every file saved, records the method, and does not re-download on the next run", async () => {
    const { sink, fetched } = sinkThatFallsBack();
    const plan = () => [planCourse(course, sources)];
    const first = await runArchive(plan(), archiveLayout, sink, store);
    expect(first).toMatchObject({ saved: 3, failed: 0, viaDownloads: 3 });
    expect(Object.values(data.get(7)?.entries ?? {}).map((e) => e.method)).toEqual(["downloads", "downloads", "downloads"]);
    expect(Object.values(data.get(7)?.entries ?? {}).every((e) => e.savedTo?.startsWith("Cornell/"))).toBe(true);
    expect(first.outcomes.every((o) => o.status === "saved" && o.inDownloads?.endsWith("(1)"))).toBe(true);
    fetched.length = 0;
    const second = await runArchive(plan(), archiveLayout, sink, store);
    expect(second).toMatchObject({ saved: 0, unchanged: 3, viaDownloads: 0, alreadyInDownloads: 3 });
    expect(fetched).toEqual([]);
  });

  it("still re-checks the folder for files that were saved into it", async () => {
    const disk = new Map<string, number>();
    const sink: FileSink = {
      keepsRecords: true,
      size: async (p) => disk.get(p.join("/")) ?? null,
      readText: async () => null,
      writeText: async () => {},
      save: async (it) => (disk.set(it.path.join("/"), 10), { size: 10, sha256: hashText("x"), method: "fetch" }),
    };
    const s2 = new Map<number, CourseManifest>();
    const st: ManifestStore = { load: async (p) => s2.get(p.courseId) ?? emptyManifest(p.courseId), save: async (p, m) => void s2.set(p.courseId, structuredClone(m)) };
    const plans = () => [planCourse(course, sources)];
    await runArchive(plans(), archiveLayout, sink, st);
    disk.clear();
    expect(await runArchive(plans(), archiveLayout, sink, st)).toMatchObject({ saved: 3, viaDownloads: 0 });
  });
});
