export default function BackendStatusPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-bold">⚡ ChargeHub API</h1>
      <p className="text-sm text-gray-500">
        This is the backend REST API. It has no UI of its own — the frontend app
        (and any client) talks to it under <code>/api/*</code>.
      </p>
      <p className="text-xs text-gray-400">
        Try <code>GET /api/stations</code> or <code>GET /api/banners</code>.
      </p>
    </main>
  );
}
