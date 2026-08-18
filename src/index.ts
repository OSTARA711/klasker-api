export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/analysis" && request.method === "POST") {
      let body: unknown;

      try {
        body = await request.json();
      } catch {
        return Response.json(
          { error: "Request body must be valid JSON." },
          { status: 400 },
        );
      }

      if (
        typeof body !== "object" ||
        body === null ||
        !("url" in body) ||
        typeof body.url !== "string"
      ) {
        return Response.json(
          { error: "A URL is required." },
          { status: 400 },
        );
      }

      let target: URL;

      try {
        target = new URL(body.url);
      } catch {
        return Response.json(
          { error: "Invalid URL." },
          { status: 400 },
        );
      }

      if (target.protocol !== "http:" && target.protocol !== "https:") {
        return Response.json(
          { error: "Only HTTP and HTTPS URLs are supported." },
          { status: 400 },
        );
      }

      const analysisId = crypto.randomUUID();

      return Response.json(
        {
          analysis_id: analysisId,
          status: "accepted",
        },
        { status: 202 },
      );
    }

    return Response.json(
      { error: "Not found." },
      { status: 404 },
    );
  },
};
