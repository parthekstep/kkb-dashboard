import { useEffect, useRef, useState } from "react";

const STARTER_PROMPTS = [
  "Why are callers not applying to jobs?",
  "What happens when jobs are shown but not applied to?",
  "What languages are callers using and does it affect outcomes?",
  "What are the most common reasons calls end early?",
];

function ChatIcon({ className = "" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function LoadingDots() {
  return (
    <span className="inline-flex gap-1 ml-1 align-middle">
      <span className="w-1 h-1 rounded-full bg-gray-500 animate-pulse" style={{ animationDelay: "0ms" }} />
      <span className="w-1 h-1 rounded-full bg-gray-500 animate-pulse" style={{ animationDelay: "150ms" }} />
      <span className="w-1 h-1 rounded-full bg-gray-500 animate-pulse" style={{ animationDelay: "300ms" }} />
    </span>
  );
}

function SourceChip({ src }) {
  const date = (src.call_datetime_ist || "").slice(0, 10) || "—";
  const topic = src.primary_topic || "—";
  return (
    <span
      title={src.call_id}
      className="inline-block bg-gray-100 text-gray-700 text-xs px-2 py-0.5 rounded border border-gray-200"
    >
      {date} · {topic}
    </span>
  );
}

export default function ChatPanel({ errorBadgeCount = 0 }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const threadRef = useRef(null);

  // Auto-scroll on new messages
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages.length, isLoading]);

  const sendMessage = async (text) => {
    const question = (text ?? "").trim();
    if (!question || isLoading) return;

    setMessages((m) => [...m, { role: "user", content: question }]);
    setInputValue("");
    setIsLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, namespace: "kkb" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: data.answer,
          sources: data.top_matches ?? [],
          question_type: data.question_type,
          sources_used: data.sources_used,
        },
      ]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: "Something went wrong. Please try again.",
          isError: true,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    sendMessage(inputValue);
  };

  return (
    <>
      {/* Floating launcher button */}
      <button
        onClick={() => setIsOpen(true)}
        aria-label="Open KKB Analyst"
        className={`fixed bottom-6 right-6 w-14 h-14 rounded-full bg-[#1F3864] text-white shadow-lg flex items-center justify-center hover:opacity-95 z-50 transition-opacity ${
          isOpen ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
      >
        <ChatIcon className="w-6 h-6" />
        {errorBadgeCount > 0 && (
          <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-red-500 border border-white" />
        )}
      </button>

      {/* Slide-in panel */}
      <aside
        className={`fixed top-0 right-0 h-screen w-[420px] max-w-full bg-white shadow-xl border-l border-gray-200 z-40 flex flex-col transition-transform duration-300 ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!isOpen}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-gray-200 px-4 py-3">
          <div>
            <div className="text-base font-semibold text-[#1F3864]">KKB Analyst</div>
            <div className="text-xs text-gray-500">AI · Powered by transcripts</div>
          </div>
          <button
            onClick={() => setIsOpen(false)}
            className="text-gray-500 hover:text-gray-800"
            aria-label="Close chat"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Thread */}
        <div ref={threadRef} className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
          {messages.length === 0 && !isLoading ? (
            <div className="flex-1 flex flex-col justify-center">
              <div className="text-sm text-gray-500 text-center mb-4">
                Ask anything about recent calls. Try one of these:
              </div>
              <div className="grid grid-cols-1 gap-2">
                {STARTER_PROMPTS.map((p) => (
                  <button
                    key={p}
                    onClick={() => sendMessage(p)}
                    className="text-left text-sm bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg px-3 py-2 text-[#1F3864]"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="self-end max-w-[85%]">
                    <div className="bg-[#1F3864] text-white text-sm rounded-2xl rounded-br-sm px-3 py-2 whitespace-pre-wrap">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="self-start max-w-[90%]">
                    <div
                      className={`text-sm rounded-2xl rounded-bl-sm px-3 py-2 whitespace-pre-wrap border ${
                        m.isError
                          ? "bg-red-50 border-red-200 text-red-700"
                          : "bg-white border-[#E5E7EB] text-gray-800"
                      }`}
                    >
                      {m.content}
                    </div>
                    {!m.isError && (m.question_type || m.sources_used != null) && (
                      <div className="text-xs text-gray-500 mt-1 px-1">
                        {m.question_type ?? "—"} · {m.sources_used ?? 0} transcripts analysed
                      </div>
                    )}
                    {!m.isError && Array.isArray(m.sources) && m.sources.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-1 px-1">
                        {m.sources.slice(0, 3).map((s, j) => (
                          <SourceChip key={j} src={s} />
                        ))}
                      </div>
                    )}
                  </div>
                )
              )}
              {isLoading && (
                <div className="self-start max-w-[90%]">
                  <div className="bg-white border border-[#E5E7EB] text-gray-700 text-sm rounded-2xl rounded-bl-sm px-3 py-2">
                    Analysing transcripts
                    <LoadingDots />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Input */}
        <form
          onSubmit={handleSubmit}
          className="border-t border-gray-200 px-3 py-2 flex items-center gap-2"
        >
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Ask about callers, themes, objections…"
            disabled={isLoading}
            className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-[#1F3864] disabled:bg-gray-50"
          />
          <button
            type="submit"
            disabled={isLoading || !inputValue.trim()}
            className="bg-[#1F3864] text-white text-sm rounded px-3 py-2 disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </aside>
    </>
  );
}
