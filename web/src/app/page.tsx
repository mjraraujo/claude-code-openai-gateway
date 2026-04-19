export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center bg-black px-6 text-zinc-100">
      <div className="flex w-full max-w-xl flex-col gap-10">
        <div className="flex items-center gap-3">
          <div
            aria-hidden
            className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.7)]"
          />
          <span className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-500">
            mission control
          </span>
        </div>

        <div className="flex flex-col gap-4">
          <h1 className="text-4xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">
            Claude Code Gateway
          </h1>
          <p className="max-w-md text-base leading-7 text-zinc-400">
            A minimalist control surface for the local Anthropic-to-OpenAI
            translation proxy. The dashboard scaffold is in place — login,
            workspace, and agent panels arrive in the next iterations.
          </p>
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-5 font-mono text-xs text-zinc-400">
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">proxy</span>
            <span className="text-zinc-300">http://localhost:18923</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">frontend</span>
            <span className="text-zinc-300">http://localhost:3000</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">status</span>
            <span className="text-emerald-400">scaffold ready</span>
          </div>
        </div>
      </div>
    </main>
  );
}
