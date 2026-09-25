/**
 * Auth spike — popup side.
 *
 * The popup is an ordinary web page living at a `chrome-extension://` URL. It
 * gets its own JavaScript context, which is destroyed the moment the popup
 * closes — so it holds no state worth keeping and does no work itself. It asks
 * the service worker to run the tests and renders what comes back.
 *
 * Note that the popup could call `fetch` directly, with the same origin and
 * permissions as the service worker. The work is delegated anyway because a
 * popup that closes mid-request cancels that request, whereas the service
 * worker keeps going.
 */

const runButton = document.getElementById("run");
const out = document.getElementById("out");

/** Escape text before putting it in innerHTML. */
function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function renderProbe(result) {
  if (result.linkHeader !== undefined) {
    return `
      <div class="row">
        <span class="verdict ${result.linkHeader ? "yes" : "no"}">
          ${result.linkHeader ? "READABLE" : "HIDDEN"}
        </span>
        <div>
          <div>HTTP ${esc(result.status)}</div>
          <pre>Link: ${esc(result.linkHeader ?? "(not visible to the extension)")}
X-Rate-Limit-Remaining: ${esc(result.rateLimitRemaining ?? "(not visible)")}</pre>
          ${result.error ? `<pre>${esc(result.error)}</pre>` : ""}
        </div>
      </div>`;
  }

  const verdict = result.authenticated ? "AUTHED" : "NOT AUTHED";
  const cls = result.authenticated ? "yes" : "no";
  const detail = result.error
    ? `<pre>${esc(result.error)}</pre>`
    : `<div>HTTP ${esc(result.status)}${result.redirected ? " (redirected)" : ""}</div>
       ${result.userName ? `<div>user: <b>${esc(result.userName)}</b></div>` : ""}
       ${result.finalUrl ? `<pre>${esc(result.finalUrl)}</pre>` : ""}
       ${!result.authenticated && result.bodyPreview ? `<pre>${esc(result.bodyPreview)}…</pre>` : ""}`;

  return `
    <div class="row">
      <span class="verdict ${cls}">${verdict}</span>
      <div><code>credentials: "${esc(result.credentials)}"</code>${detail}</div>
    </div>`;
}

function render(report) {
  out.innerHTML = report.tests
    .map((test) => {
      const body = test.skipped
        ? `<div class="row"><span class="verdict skip">SKIPPED</span><div>${esc(test.skipped)}</div></div>`
        : test.results.map(renderProbe).join("");
      return `
        <section class="test">
          <h2>${esc(test.name)}</h2>
          <p class="detail">${esc(test.detail)}</p>
          ${body}
        </section>`;
    })
    .join("");
}

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  runButton.textContent = "Running…";
  out.textContent = "";

  try {
    const report = await chrome.runtime.sendMessage({ type: "RUN_SPIKE" });
    render(report);
    console.log("[spike] full report", report);
  } catch (error) {
    out.innerHTML = `<pre>${esc(error)}</pre>`;
  } finally {
    runButton.disabled = false;
    runButton.textContent = "Run spike again";
  }
});
