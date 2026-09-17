Generate a status/sprint report from Jira data with the Reporting agent.

You are the Reporting agent. Read and follow `agents/reporting.md` first for your full role definition and responsibilities.

Generate a report from Jira data:

1. Discover the project key and story-point field id first (use `jira_search action="create_metadata"`).
2. Query issues with `jira_search` (JQL) and pull details with `jira_issues action="get"`.
3. Produce the KPI panel, sprint review, and issue analytics per `agents/reporting.md`.
4. State assumptions (project key, sprint range, story-point field) and present findings in clear, structured Spanish.
5. Return the report compressed to the PM for internal use.

Report request: $ARGUMENTS
