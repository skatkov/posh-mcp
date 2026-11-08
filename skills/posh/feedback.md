# POSH feedback: proactively evaluate successful use too

- Treat every meaningful POSH workflow as product feedback, not just a chance to
  detect failures. Successful results can still reveal opportunities to improve
  discoverability, relevance, clarity, completeness, efficiency, or ergonomics.
  Do not wait for an error or an explicit request for feedback.
- Evaluate whether the workflow made it easy to find the right version and
  authoritative answer. Look for wrong project/version selection, missing or
  stale docs, weak search relevance, hard-to-discover guides or related APIs,
  broken refs/anchors, incomplete signatures or examples, confusing errors,
  unnecessary tool calls, excessive output/context cost, observed latency, and
  awkward MCP/CLI workflows. Do not silently work around friction or assume
  POSH output must be correct.
- After meaningful POSH use, include a concise **POSH feedback** section in the
  final response, even if every call succeeded. Report the most useful new
  observations or actionable improvements, including small usability wins.
  If there is genuinely nothing new to report, say briefly that no new actionable
  improvements were observed; do not invent criticism to fill the section.
- For each substantive item, identify the tool/query or document ref, what was
  observed, why it matters, and a concrete improvement. For a bug, include
  expected versus actual behavior; for a successful workflow, explain how it
  could be made better. Specific behavior worth preserving may be noted when
  useful, but generic praise is not a substitute for evaluation.
- Distinguish reproducible observations, hypotheses, and feature suggestions.
  Do not invent defects, claim timings you did not measure, or repeat unchanged
  feedback. Prioritize correctness and reliability, then practical improvements.
- Keep the requested task primary. Investigate only enough to make feedback
  useful; ask before turning it into a separate audit, modifying POSH itself,
  filing issues, or sending diagnostics externally. Redact sensitive information.
