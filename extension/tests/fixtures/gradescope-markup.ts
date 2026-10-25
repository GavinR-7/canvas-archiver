/**
 * RECONSTRUCTED Gradescope markup — not a capture.
 *
 * Written from memory of Gradescope's student pages (class names
 * `courseBox`, `submissionStatus--text`, `submissionTimeChart--dueDate`), with
 * no signed-in session available when this slice was built. It pins the
 * parser's behaviour, not Gradescope's. First real-account run is the check
 * that matters: if a row is missing there, replace this fixture with a
 * redacted capture and fix the parser against it.
 */

export const ACCOUNT_PAGE = `
<h1 class="pageHeading">Your Courses</h1>
<div class="courseList">
  <div class="courseList--term">Fall 2026</div>
  <div class="courseList--coursesForTerm">
    <a class="courseBox" href="/courses/900001">
      <h3 class="courseBox--shortname">CS 3700</h3>
      <div class="courseBox--name">Networks &amp; Operating Systems</div>
      <div class="courseBox--assignments">4 assignments</div>
    </a>
    <a class="courseBox" href="/courses/900002">
      <h3 class="courseBox--shortname">ECE 3140</h3>
      <div class="courseBox--name">Embedded Systems</div>
    </a>
  </div>
  <div class="courseList--term">Spring 2026</div>
  <div class="courseList--coursesForTerm">
    <a class="courseBox" href="/courses/800001">
      <h3 class="courseBox--shortname">CS 2110</h3>
      <div class="courseBox--name">OOP and Data Structures</div>
    </a>
  </div>
</div>`;

export const COURSE_PAGE = `
<table id="assignments-student-table" class="table">
<thead><tr><th>Name</th><th>Status</th><th>Released / Due</th></tr></thead>
<tbody>
<tr role="row">
  <th class="table--primaryLink" scope="row">
    <a aria-label="Project 1 &amp; Setup" href="/courses/900001/assignments/5550001/submissions/77001">Project 1 &amp; Setup</a>
  </th>
  <td class="submissionStatus"><div class="submissionStatus--score">92.0 / 100.0</div></td>
  <td><div class="progressBar--caption">
    <time class="submissionTimeChart--releaseDate" datetime="2026-09-01 00:00:00 -0400">Released: Sep 01</time>
    <time class="submissionTimeChart--dueDate" datetime="2026-09-15 23:59:00 -0400">Due: Sep 15 at 11:59PM</time>
  </div></td>
</tr>
<tr role="row">
  <th class="table--primaryLink" scope="row">
    <button class="js-submitAssignment link-gray" data-assignment-id="5550002" data-post-url="/courses/900001/assignments/5550002/submissions">Project 2</button>
  </th>
  <td class="submissionStatus"><div class="submissionStatus--text">No Submission</div></td>
  <td><div class="progressBar--caption">
    <time class="submissionTimeChart--releaseDate" datetime="2026-10-01 00:00:00 -0400">Released: Oct 01</time>
    <time class="submissionTimeChart--dueDate" datetime="2026-10-20 23:59:00 -0400">Due: Oct 20 at 11:59PM</time>
    <time class="submissionTimeChart--dueDate" datetime="2026-10-22 23:59:00 -0400">Late Due Date: Oct 22 at 11:59PM</time>
  </div></td>
</tr>
<tr role="row">
  <th class="table--primaryLink" scope="row">
    <a href="/courses/900001/assignments/5550003/submissions/77003">Quiz 4</a>
  </th>
  <td class="submissionStatus"><div class="submissionStatus--text">Submitted</div></td>
  <td><div class="progressBar--caption">
    <time class="submissionTimeChart--dueDate" datetime="2026-11-02 18:00:00 -0500">Due: Nov 02 at 6:00PM</time>
  </div></td>
</tr>
<tr role="row">
  <th class="table--primaryLink" scope="row"><span>Not an assignment row</span></th>
  <td></td><td></td>
</tr>
</tbody>
</table>`;
