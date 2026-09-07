let calls = 0;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/calls") return Response.json(calls);
    calls += 1;
    const status = Number(url.pathname.split("/")[1]);
    if (status >= 300 && status < 400) {
      return Response.redirect("https://destination.test/", status);
    }
    return Response.json({
      authorization: request.headers.get("authorization"),
      app: request.headers.get("x-cail-app"),
      body: await request.json(),
    });
  },
};
