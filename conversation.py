"""
Conversation memory: lets follow-up questions reference earlier answers in
the same session ("what about its limitations?" right after asking about
the main findings).

Deliberately narrow in scope:

  - Threaded into GENERATION only, as proper multi-turn chat messages
    (Ollama accepts a list of role/content turns natively — standard
    mechanism for multi-turn chat, not a homemade string format).
    This lets the model resolve pronouns/follow-up phrasing when composing
    its answer.

  - Retrieval stays single-turn: hybrid_retrieve/get_chunks_by_pages search
    using only the CURRENT question's text, never history. Two reasons:
    (1) query_understanding.parse_query uses plain regex to detect
    'page N'/'filter:'/'broad:'/'summarize:' - if an earlier answer's text
    got concatenated into the next query before parsing, a stray token in
    that answer could misfire intent routing on a totally unrelated
    question; (2) it keeps retrieval predictable and tied to what you just
    typed, rather than silently drifting based on history you're not
    necessarily tracking mentally.

  - Only the question and final answer text are stored per turn - not the
    retrieved context that produced the answer. Re-sending full retrieved
    context on every subsequent turn would make each turn's request grow
    without bound and duplicate information the answer already
    synthesized; the answer text is what a follow-up actually needs to
    refer back to.

  - Summarization turns are never added (see main.py) - summaries can be
    long, and every future turn would carry that weight for the life of
    the history window.
"""
from collections import deque
from threading import Lock


class ConversationMemory:
    """
    Bounded history of (question, answer) turns. Toggling `enabled` off
    doesn't discard what's already stored - it just stops threading it
    into new generation calls, so turning memory back on resumes with
    whatever context had already accumulated.

    Thread-safe: the server drives one of these per session from request
    threads and a streaming generator concurrently, so every mutation and
    every snapshot takes a lock. Iteration in as_messages() copies under
    the lock - a turn added mid-generation lands in the NEXT turn, never
    a half-built history.
    """

    def __init__(self, max_turns):
        if not isinstance(max_turns, int) or max_turns < 1:
            raise ValueError(f"max_turns must be a positive int, got {max_turns!r}")
        self.max_turns = max_turns
        self.enabled = True
        self._turns = deque(maxlen=max_turns)
        self._lock = Lock()

    def add(self, question, answer):
        if question is None or answer is None:
            return
        with self._lock:
            self._turns.append((str(question), str(answer)))

    def clear(self):
        with self._lock:
            self._turns.clear()

    def __len__(self):
        with self._lock:
            return len(self._turns)

    def as_messages(self):
        """Chat-formatted history for the current turn's generation call.
        Empty whenever memory is toggled off, regardless of what's stored,
        or when nothing has been recorded yet."""
        with self._lock:
            if not self.enabled:
                return []
            turns = list(self._turns)
        messages = []
        for question, answer in turns:
            messages.append({"role": "user", "content": question})
            messages.append({"role": "assistant", "content": answer})
        return messages
