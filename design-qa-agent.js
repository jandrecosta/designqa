#!/usr/bin/env node
/**
 * Design QA Agent — workshop stub
 *
 * Runs on every pull request. Fetches the diff, checks it against the
 * design system's component manifest, and posts a pass/fail result back
 * to the PR.
 *
 * ALREADY WIRED: fetching the diff, reading the manifest, calling
 * Claude, handling API errors, parsing the response, posting the
 * result, exiting with the right status code.
 *
 * YOUR JOB: fill in buildPrompt() — write the prompt that decides
 * whether the diff follows the design system.
 *
 * File paths below are placeholders. Update them to match your repo.
 */

import fs from "node:fs";

// --- Placeholders — update these to match your repo structure ---
const PLACEHOLDER_MANIFEST_PATH = "./manifest.json"; // now pointed at the real manifest
const CLAUDE_MODEL = "claude-opus-5-5";

// ============================================================
// ALREADY WIRED — fetch the PR diff
// ============================================================
async function fetchDiff() {
  const repo = process.env.GITHUB_REPOSITORY; // e.g. "your-username/your-repo"
  const prNumber = process.env.PR_NUMBER;
  const token = process.env.GITHUB_TOKEN;

  const res = await fetch(
    `https://api.github.com/repos/${repo}/pulls/${prNumber}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3.diff",
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch diff: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

// ============================================================
// ALREADY WIRED — read the component manifest
// ============================================================
function readManifest() {
  return fs.readFileSync(PLACEHOLDER_MANIFEST_PATH, "utf-8");
}

// ============================================================
// Prefix every added and context line with its line number in the
// new file, so the model doesn't have to count from hunk headers.
//   "+  44| code"  added line 44
//   "   45| code"  unchanged line 45
//   "-    | code"  removed line (no longer in the file)
// ============================================================
function annotateDiff(diff) {
  let newLine = 0;
  return diff
    .split("\n")
    .map((line) => {
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        newLine = Number(hunk[1]);
        return line;
      }
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
        return line;
      }
      if (line.startsWith("+")) return `+${String(newLine++).padStart(4)}| ${line.slice(1)}`;
      if (line.startsWith("-")) return `-    | ${line.slice(1)}`;
      if (line.startsWith(" ")) return ` ${String(newLine++).padStart(4)}| ${line.slice(1)}`;
      return line;
    })
    .join("\n");
}

// ============================================================
// YOUR JOB — write the prompt
//
// This is the only part you need to write. Everything else below
// (calling the API, handling errors, parsing the result) is already
// wired up and working.
//
// Write a prompt that asks Claude to compare the diff against the
// manifest and decide pass/fail. Things worth including:
//   - Reference the manifest explicitly, don't just say "the design system"
//   - Say what counts as an issue: breaking a rule in the manifest,
//     and nothing else. Then adding a rule to the manifest is enough
//     to start checking it, with no change to this prompt
//   - Ask for structured reasoning, not just a verdict
//
// IMPORTANT: whatever you ask for, it must come back as valid JSON in
// exactly this shape, because that's what the code below expects:
//   {
//     "pass": true or false,
//     "findings": [
//       { "file": "...", "line": "...", "issue": "...", "reasoning": "..." }
//     ]
//   }
// If there are no issues, "pass" should be true and "findings" empty.
// ============================================================
function buildPrompt(diff, manifest) {
  return `You are a design QA reviewer for a pull request. Your single source of
truth is the component manifest below. Compare the code in the diff against
the manifest and decide whether the diff complies with it.

Rules for your review:
- The manifest is the ONLY authority. Check the diff against everything it
  defines: approvedVariants, approvedSizes, deprecatedVariants, and every
  entry in "rules", "accessibilityRules", and "responsiveRules".
- An issue is a violation of something stated in the manifest, and nothing
  else. Do not flag anything the manifest does not cover — no personal style
  opinions, no rules that are not written in the manifest. If a rule is not
  in the manifest, it is not an issue, even if you would normally recommend
  it. (This means adding a rule to the manifest is all it takes to start
  enforcing it — your review automatically picks it up.)
- Only review lines that the diff adds or changes (lines starting with "+").
  Lines starting with "-" have been removed and no longer exist; never report
  them, even if they broke a rule. Unchanged lines (starting with a space)
  are context only.
- Report only violations that are present in the added lines as they are
  now. If you check something and conclude it complies, or that a violation
  was fixed by this diff, leave it out entirely. A finding must never say
  that something is valid, correct, or already fixed.
- Every diff line is prefixed with its line number in the new file, e.g.
  "+  44| <code>". Use that number as "line". Do not count lines yourself
  and do not use positions within the diff.
- For every issue, give the file, the line, a short description of what is
  wrong, and reasoning that cites the specific manifest rule, approved list,
  or deprecated variant it violates.

Respond with ONLY valid JSON — no markdown, no prose outside the JSON — in
exactly this shape:
{
  "pass": true or false,
  "findings": [
    { "file": "...", "line": "...", "issue": "...", "reasoning": "..." }
  ]
}
Set "pass" to false if there is at least one finding, true otherwise. If
there are no issues, "pass" must be true and "findings" must be an empty array.

Manifest:
${manifest}

Diff:
${annotateDiff(diff)}`;
}

// ============================================================
// ALREADY WIRED — calls Claude, checks for API errors, and parses
// the JSON response. You shouldn't need to touch this function.
// ============================================================
async function checkDesignCompliance(diff, manifest) {
  const prompt = buildPrompt(diff, manifest);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "server-side-fallback-2026-07-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      // Thinking is always on for this model and counts toward max_tokens.
      max_tokens: 16000,
      // If a safety classifier declines, retry on a fallback model in the same call.
      fallbacks: "default",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(`Anthropic API error (status ${response.status}):`, JSON.stringify(data, null, 2));
    return {
      pass: false,
      findings: [{
        file: "-",
        line: "-",
        issue: "API call failed",
        reasoning: data?.error?.message || `HTTP ${response.status}`,
      }],
    };
  }

  if (data.stop_reason === "refusal") {
    return {
      pass: false,
      findings: [{
        file: "-",
        line: "-",
        issue: "Model declined the request",
        reasoning: data.stop_details?.explanation || "stop_reason: refusal",
      }],
    };
  }

  // The response starts with a thinking block, so find the text block.
  const text = data.content?.find((block) => block.type === "text")?.text ?? "";

  try {
    const cleaned = text.replace(/```json\n?|```\n?/g, "").trim();
    const result = JSON.parse(cleaned);
    return {
      pass: result.pass === true,
      findings: Array.isArray(result.findings) ? result.findings : [],
    };
  } catch (err) {
    console.error("Failed to parse Claude's response as JSON:", text);
    return {
      pass: false,
      findings: [{ file: "-", line: "-", issue: "Agent response could not be parsed", reasoning: text.slice(0, 300) }],
    };
  }
}


// ============================================================
// ALREADY WIRED — post the result back to the PR
// ============================================================
async function postResult(result) {
  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = process.env.PR_NUMBER;
  const token = process.env.GITHUB_TOKEN;

  const body = result.pass
    ? `Design QA agent: no issues found.`
    : `Design QA agent found issues:\n\n${result.findings
        .map((f) => `- **${f.file}:${f.line}** — ${f.issue}\n  ${f.reasoning}`)
        .join("\n")}`;

  const commentRes = await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ body }),
  });

  if (!commentRes.ok) {
    const errText = await commentRes.text();
    console.error(`Failed to post comment (status ${commentRes.status}):`, errText);
  } else {
    console.log("Comment posted successfully.");
  }

  // Non-zero exit makes the GitHub Action report a failed check.
  process.exit(result.pass ? 0 : 1);
}

// ============================================================
// ALREADY WIRED — run it
// ============================================================
(async function main() {
  try {
    const diff = await fetchDiff();
    const manifest = readManifest();
    const result = await checkDesignCompliance(diff, manifest);
    await postResult(result);
  } catch (err) {
    console.error("Design QA agent failed to run:", err);
    process.exit(1);
  }
})();