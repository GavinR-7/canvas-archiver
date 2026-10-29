/**
 * Current-term filter for a course list, with a per-view "Show all" switch.
 *
 * Visibility only: the full list is still what is stored and archived. The
 * switch persists per view (popup, files, chat) in chrome.storage.local.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { REASON_TEXT, splitCourses, type CourseSplit } from "@/src/canvas/visibility";
import type { Course } from "@/src/types/canvas";

export type CourseView = "popup" | "files" | "chat";

const key = (view: CourseView) => `courses.showAll.${view}`;

export interface CourseFilter {
  /** What the list should render. */
  courses: Course[];
  /** The current-term courses, regardless of Show all (the default selection). */
  current: Course[];
  hidden: CourseSplit["hidden"];
  showAll: boolean;
  toggle: () => void;
}

export function useCourseFilter(view: CourseView, all: Course[]): CourseFilter {
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setShowAll((await chrome.storage.local.get(key(view)))[key(view)] === true);
      } catch {
        // No storage means the default: collapsed.
      }
    })();
  }, [view]);

  const split = useMemo(() => splitCourses(all, new Date()), [all]);

  useEffect(() => {
    if (split.hidden.length === 0) return;
    console.debug(
      `[canvas-archiver] ${view}: ${split.hidden.length} course(s) hidden by the current-term filter`,
      split.hidden.map(({ course, reason }) => `${course.courseCode || course.name} (${REASON_TEXT[reason]})`),
    );
  }, [split, view]);

  const toggle = useCallback(() => {
    setShowAll((previous) => {
      const next = !previous;
      try {
        void chrome.storage.local.set({ [key(view)]: next });
      } catch {
        // Not persisted; still applies for this page.
      }
      return next;
    });
  }, [view]);

  return { courses: showAll ? all : split.shown, current: split.shown, hidden: split.hidden, showAll, toggle };
}
