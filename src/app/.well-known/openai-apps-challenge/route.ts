const OPENAI_APPS_CHALLENGE_TOKEN =
  "5ufJ4BzJR-nDzwTWcxy5dpQ5pq-tZDvbkklG_6VKE-A";

export function GET(): Response {
  return new Response(OPENAI_APPS_CHALLENGE_TOKEN, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
