/**
 * Reconstructed Gradescope assignment-page markup for the handout parser.
 *
 * Not a capture: invented ids and course names, shaped like the pages the
 * existing fixture (`gradescope-markup.ts`) models. Whether real pages link
 * handouts this way is the open question in NEXT.md; the parser is written to
 * the shapes below and nothing else is promised.
 */

/** Project 1 (id 5550001) in course 900001: an assignment PDF, a handout by attachment id, and noise. */
export const ASSIGNMENT_WITH_HANDOUTS = `
<html><body>
  <nav><a href="/account">Your Courses</a> <a href="/courses/900001">CS 3700</a></nav>
  <div class="actionBar">
    <a class="actionBar--action" href="/courses/900001/assignments/5550001/files/Project%201%20Spec.pdf">Download Assignment</a>
    <a class="actionBar--action" href="https://www.gradescope.com/courses/900001/assignments/5550001/attachments/77/download?x=1&amp;y=2">Starter handout</a>
    <a class="actionBar--action" href="/courses/900001/assignments/5550001/submissions/77001.pdf">Download Your Submission</a>
    <a href="/courses/900001/assignments/5550002/files/Other.pdf">Next assignment's spec</a>
    <a href="https://evil.example.com/courses/900001/assignments/5550001/files/Trap.pdf">Mirror</a>
    <a href="/courses/900001/assignments/5550001/files/Project%201%20Spec.pdf">Download Assignment (again)</a>
    <a href="/courses/900001/assignments/5550001/review_grades">Review Grades</a>
  </div>
</body></html>`;

export const ASSIGNMENT_WITHOUT_FILES = `
<html><body>
  <h1>Quiz 4</h1>
  <a href="/courses/900001/assignments/5550003/submissions/77003">Your submission</a>
  <a href="/courses/900001/assignments/5550003/review_grades">Review Grades</a>
</body></html>`;
