let calls = 0;

export default {
  fetch(request: Request): Response {
    if (new URL(request.url).pathname === "/calls") return Response.json(calls);
    calls += 1;
    return new Response("Redirect followed");
  },
};
