export async function postSlack(webhookUrl, text) {
  if (!webhookUrl) return false;
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack webhook -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return true;
}

// Returns the issue URL. Retries without labels if the label does not exist yet (422).
export async function openIssue(gh, repo, { title, body, labels }) {
  try {
    return (await gh.createIssue(repo, { title, body, labels })).html_url;
  } catch (e) {
    if (e.status !== 422) throw e;
    return (await gh.createIssue(repo, { title, body })).html_url;
  }
}
