import QRCode from "qrcode";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, getErrorMessage } from "./api";
import { eventCopy } from "./copy";
import type {
  EventDetail,
  EventSummary,
  Language,
  OwnerEventPayload,
  PublicEvent,
  Question,
  QuestionStatus,
  Talk,
  User,
} from "./types";

type Route =
  | { kind: "public"; slug: string }
  | { kind: "owner"; eventId: string | null };

type MeResponse = {
  user: User | null;
};

type EventDetailResponse = {
  event: EventDetail;
  talks: Talk[];
};

const defaultAccent = "#0f8bff";

export default function App() {
  const [route, setRoute] = useRoute();
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    if (route.kind === "public") return;
    void api<MeResponse>("/api/me")
      .then((data) => setUser(data.user))
      .catch(() => setUser(null));
  }, [route.kind]);

  if (route.kind === "public") {
    return <PublicEventPage slug={route.slug} />;
  }

  if (user === undefined) {
    return <PageShell><Notice>Loading workspace...</Notice></PageShell>;
  }

  if (!user) {
    return <AuthScreen onAuth={setUser} />;
  }

  return <OwnerApp user={user} route={route} navigate={setRoute} onLogout={() => setUser(null)} />;
}

function useRoute(): [Route, (route: Route) => void] {
  const getRoute = () => parseRoute(window.location.pathname);
  const [route, setRouteState] = useState<Route>(getRoute);

  useEffect(() => {
    const listener = () => setRouteState(getRoute());
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);

  const navigate = (nextRoute: Route) => {
    const path = nextRoute.kind === "public" ? `/e/${nextRoute.slug}` : nextRoute.eventId ? `/app/events/${nextRoute.eventId}` : "/app";
    window.history.pushState(null, "", path);
    setRouteState(nextRoute);
  };

  return [route, navigate];
}

function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "e" && parts[1]) {
    return { kind: "public", slug: parts[1] };
  }
  if (parts[0] === "app" && parts[1] === "events" && parts[2]) {
    return { kind: "owner", eventId: parts[2] };
  }
  return { kind: "owner", eventId: null };
}

function AuthScreen({ onAuth }: { onAuth: (user: User) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");

    try {
      const data = await api<{ user: User }>(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      onAuth(data.user);
      window.history.replaceState(null, "", "/app");
    } catch (authError) {
      setError(getErrorMessage(authError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <PageShell className="auth-shell">
      <section className="auth-panel">
        <BrandMark />
        <div className="auth-copy">
          <h1>Live Q&A for any event</h1>
          <p>Create an event page, share a QR code, and let the audience ask and vote from their phones.</p>
        </div>
        <form className="stack-form" onSubmit={submit}>
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={10} required />
          </label>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <button className="primary-button" type="submit" disabled={loading}>
            {loading ? "Please wait..." : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
        <button className="text-button" type="button" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
          {mode === "login" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>
      </section>
    </PageShell>
  );
}

function OwnerApp({
  user,
  route,
  navigate,
  onLogout,
}: {
  user: User;
  route: Extract<Route, { kind: "owner" }>;
  navigate: (route: Route) => void;
  onLogout: () => void;
}) {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadEvents() {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ events: EventSummary[] }>("/api/owner/events");
      setEvents(data.events);
      if (!route.eventId && data.events[0]) {
        navigate({ kind: "owner", eventId: data.events[0].id });
      }
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadEvents();
  }, []);

  async function createEvent() {
    setError(null);
    try {
      const data = await api<{ event: EventSummary }>("/api/owner/events", {
        method: "POST",
        body: JSON.stringify({ title: "Untitled event" }),
      });
      setEvents((current) => [data.event, ...current]);
      navigate({ kind: "owner", eventId: data.event.id });
    } catch (createError) {
      setError(getErrorMessage(createError));
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    onLogout();
    window.history.replaceState(null, "", "/");
  }

  return (
    <div className="owner-shell">
      <aside className="owner-sidebar">
        <div className="sidebar-top">
          <BrandMark />
          <button className="icon-button" type="button" aria-label="Create event" onClick={createEvent}>
            <Icon name="plus" />
          </button>
        </div>
        <nav className="event-nav" aria-label="Events">
          {events.map((event) => (
            <button
              key={event.id}
              className={route.eventId === event.id ? "selected" : ""}
              type="button"
              onClick={() => navigate({ kind: "owner", eventId: event.id })}
            >
              <strong>{event.title}</strong>
              <span>{event.isPublished ? "Published" : "Draft"} / {event.slug}</span>
            </button>
          ))}
        </nav>
        <div className="account-row">
          <span>{user.email}</span>
          <button type="button" onClick={logout}>Sign out</button>
        </div>
      </aside>

      <main className="owner-main">
        {error ? <Notice tone="error">{error}</Notice> : null}
        {loading ? <Notice>Loading events...</Notice> : null}
        {!route.eventId && !loading ? <EmptyWorkspace onCreate={createEvent} /> : null}
        {route.eventId ? (
          <EventEditor
            eventId={route.eventId}
            events={events}
            onEventSaved={(event) => {
              setEvents((current) => current.map((item) => (item.id === event.id ? event : item)));
            }}
          />
        ) : null}
      </main>
    </div>
  );
}

function EmptyWorkspace({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="empty-workspace">
      <h1>Create your first event</h1>
      <p>Each event gets its own public link, QR code, talks, Q&A list, language, colors, and footer call to action.</p>
      <button className="primary-button" type="button" onClick={onCreate}>
        <Icon name="plus" />
        New event
      </button>
    </section>
  );
}

function EventEditor({
  eventId,
  events,
  onEventSaved,
}: {
  eventId: string;
  events: EventSummary[];
  onEventSaved: (event: EventSummary) => void;
}) {
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [draft, setDraft] = useState<OwnerEventPayload | null>(null);
  const [talks, setTalks] = useState<Talk[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [qr, setQr] = useState<string>("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const publicUrl = event ? `${window.location.origin}/e/${event.slug}` : "";
  const eventSummary = events.find((item) => item.id === eventId);

  async function loadEvent() {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api<EventDetailResponse>(`/api/owner/events/${eventId}`);
      setEvent(data.event);
      setDraft(toOwnerPayload(data.event));
      setTalks(data.talks);
      await loadQuestions();
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function loadQuestions() {
    const data = await api<{ questions: Question[] }>(`/api/owner/events/${eventId}/questions`);
    setQuestions(data.questions);
  }

  useEffect(() => {
    void loadEvent();
  }, [eventId]);

  useEffect(() => {
    if (!publicUrl) return;
    void QRCode.toDataURL(publicUrl, {
      width: 192,
      margin: 1,
      color: { dark: "#111827", light: "#ffffff" },
    }).then(setQr);
  }, [publicUrl]);

  async function saveEvent(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (!draft) return;
    setNotice(null);
    setError(null);

    try {
      const data = await api<{ event: EventDetail }>(`/api/owner/events/${eventId}`, {
        method: "PATCH",
        body: JSON.stringify(draft),
      });
      setEvent(data.event);
      setDraft(toOwnerPayload(data.event));
      onEventSaved(data.event);
      setNotice("Event saved.");
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    }
  }

  async function saveTalks() {
    setNotice(null);
    setError(null);
    try {
      const data = await api<{ talks: Talk[] }>(`/api/owner/events/${eventId}/talks`, {
        method: "PUT",
        body: JSON.stringify({ talks }),
      });
      setTalks(data.talks);
      setNotice("Talks saved.");
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    }
  }

  async function updateQuestion(questionId: string, patch: Partial<Pick<Question, "status" | "pinned">>) {
    setError(null);
    try {
      await api(`/api/owner/questions/${questionId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      await loadQuestions();
    } catch (updateError) {
      setError(getErrorMessage(updateError));
    }
  }

  if (loading || !draft || !event) {
    return <Notice>{eventSummary ? `Loading ${eventSummary.title}...` : "Loading event..."}</Notice>;
  }

  const updateDraft = <K extends keyof OwnerEventPayload>(key: K, value: OwnerEventPayload[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  return (
    <div className="editor-grid">
      <section className="editor-main-card">
        <div className="section-head">
          <div>
            <h1>{event.title}</h1>
            <p>Customize the public page, language, sharing details, and event state.</p>
          </div>
          <a className="secondary-button" href={publicUrl} target="_blank" rel="noreferrer">
            Open public page
          </a>
        </div>
        {notice ? <Notice tone="success">{notice}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}

        <form className="settings-grid" onSubmit={saveEvent}>
          <label className="wide-field">
            Event title
            <input value={draft.title} onChange={(input) => updateDraft("title", input.currentTarget.value)} required />
          </label>
          <label>
            Public slug
            <input value={draft.slug} onChange={(input) => updateDraft("slug", input.currentTarget.value)} required />
          </label>
          <label>
            Language
            <select value={draft.language} onChange={(input) => updateDraft("language", input.currentTarget.value as Language)}>
              <option value="en">English</option>
              <option value="es">Spanish</option>
            </select>
          </label>
          <label>
            Date label
            <input value={draft.dateLabel} onChange={(input) => updateDraft("dateLabel", input.currentTarget.value)} />
          </label>
          <label>
            Location label
            <input value={draft.locationLabel} onChange={(input) => updateDraft("locationLabel", input.currentTarget.value)} />
          </label>
          <label>
            Accent color
            <span className="color-field">
              <input type="color" value={draft.accentColor} onChange={(input) => updateDraft("accentColor", input.currentTarget.value)} />
              <input value={draft.accentColor} onChange={(input) => updateDraft("accentColor", input.currentTarget.value)} />
            </span>
          </label>
          <label>
            Published
            <select value={draft.isPublished ? "yes" : "no"} onChange={(input) => updateDraft("isPublished", input.currentTarget.value === "yes")}>
              <option value="yes">Published</option>
              <option value="no">Draft</option>
            </select>
          </label>
          <label>
            Archive
            <select value={draft.isArchived ? "yes" : "no"} onChange={(input) => updateDraft("isArchived", input.currentTarget.value === "yes")}>
              <option value="no">Active</option>
              <option value="yes">Archived</option>
            </select>
          </label>
          <label className="wide-field">
            Intro text
            <textarea rows={3} value={draft.introText} onChange={(input) => updateDraft("introText", input.currentTarget.value)} />
          </label>
          <label>
            Ask button label
            <input value={draft.askButtonLabel} onChange={(input) => updateDraft("askButtonLabel", input.currentTarget.value)} />
          </label>
          <label>
            Footer label
            <input value={draft.footerLabel} onChange={(input) => updateDraft("footerLabel", input.currentTarget.value)} />
          </label>
          <label className="wide-field">
            Footer URL
            <input type="url" value={draft.footerUrl} onChange={(input) => updateDraft("footerUrl", input.currentTarget.value)} />
          </label>
          <div className="form-actions">
            <button className="primary-button" type="submit">Save event</button>
          </div>
        </form>
      </section>

      <aside className="share-panel">
        <h2>Share</h2>
        <img src={qr} alt="Event QR code" />
        <code>{publicUrl}</code>
        <button className="secondary-button" type="button" onClick={() => void navigator.clipboard.writeText(publicUrl)}>
          Copy link
        </button>
      </aside>

      <section className="talk-editor editor-main-card">
        <div className="section-head compact">
          <div>
            <h2>Talks</h2>
            <p>Group speakers who share the same talk. The title is shown when attendees ask a question.</p>
          </div>
          <button className="secondary-button" type="button" onClick={() => setTalks((current) => [...current, newTalk(current.length)])}>
            <Icon name="plus" />
            Add talk
          </button>
        </div>
        <div className="talk-list-editor">
          {talks.map((talk, index) => (
            <article className="talk-edit-row" key={talk.id}>
              <span className="row-number">{index + 1}</span>
              <label>
                Title
                <input value={talk.title} onChange={(input) => updateTalk(talks, setTalks, talk.id, { title: input.currentTarget.value })} />
              </label>
              <label>
                Speakers
                <input value={talk.speakers} onChange={(input) => updateTalk(talks, setTalks, talk.id, { speakers: input.currentTarget.value })} />
              </label>
              <label>
                Subtitle
                <input value={talk.role} onChange={(input) => updateTalk(talks, setTalks, talk.id, { role: input.currentTarget.value })} />
              </label>
              <button className="icon-button danger" type="button" aria-label="Remove talk" onClick={() => setTalks((current) => current.filter((item) => item.id !== talk.id))}>
                <Icon name="trash" />
              </button>
            </article>
          ))}
        </div>
        <button className="primary-button" type="button" onClick={saveTalks}>Save talks</button>
      </section>

      <section className="question-admin editor-main-card">
        <div className="section-head compact">
          <div>
            <h2>Questions</h2>
            <p>Pin the questions to answer live, mark them answered, or hide noisy entries.</p>
          </div>
          <button className="secondary-button" type="button" onClick={() => void loadQuestions()}>Refresh</button>
        </div>
        <div className="question-admin-list">
          {questions.map((question) => (
            <article className="admin-question-card" key={question.id}>
              <div>
                <span>{question.talkTitle ?? "Deleted talk"}</span>
                <p>{question.body}</p>
                <small>{question.score} votes / {question.status}{question.pinned ? " / pinned" : ""}</small>
              </div>
              <div className="admin-actions">
                <button type="button" onClick={() => void updateQuestion(question.id, { pinned: !question.pinned })}>
                  {question.pinned ? "Unpin" : "Pin"}
                </button>
                <button type="button" onClick={() => void updateQuestion(question.id, { status: "answered" })}>Answered</button>
                <button type="button" onClick={() => void updateQuestion(question.id, { status: "hidden", pinned: false })}>Hide</button>
              </div>
            </article>
          ))}
          {!questions.length ? <div className="empty-list">No questions yet.</div> : null}
        </div>
      </section>
    </div>
  );
}

function PublicEventPage({ slug }: { slug: string }) {
  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [selectedTalk, setSelectedTalk] = useState("all");
  const [filter, setFilter] = useState<"open" | "answered" | "all">("open");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [theme, setTheme] = useState(getInitialTheme);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const voterId = useMemo(getOrCreateVoterId, []);

  const strings = eventCopy(event?.language ?? "en");

  async function loadEvent() {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ event: PublicEvent }>(`/api/public/events/${slug}`);
      setEvent(data.event);
      await loadQuestions(data.event.id);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function loadQuestions(_: string = event?.id ?? "") {
    const talkParam = selectedTalk === "all" ? "" : `&talkId=${selectedTalk}`;
    const data = await api<{ questions: Question[] }>(
      `/api/public/events/${slug}/questions?voterId=${encodeURIComponent(voterId)}&status=${filter}${talkParam}`,
    );
    setQuestions(data.questions);
  }

  useEffect(() => {
    void loadEvent();
  }, [slug]);

  useEffect(() => {
    if (!event) return;
    void loadQuestions(event.id);
  }, [filter, selectedTalk]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("preguntaya-theme", theme);
  }, [theme]);

  async function submitQuestion(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (!event) return;
    const form = new FormData(formEvent.currentTarget);
    const talkId = String(form.get("talkId") ?? "");
    const body = String(form.get("body") ?? "").trim();
    const authorName = String(form.get("authorName") ?? "").trim();

    try {
      await api(`/api/public/events/${slug}/questions`, {
        method: "POST",
        body: JSON.stringify({ talkId, body, authorName }),
      });
      setSheetOpen(false);
      await loadQuestions(event.id);
    } catch (submitError) {
      setError(getErrorMessage(submitError));
    }
  }

  async function vote(questionId: string, requestedValue: number) {
    const current = questions.find((question) => question.id === questionId)?.userVote ?? 0;
    const value = current === requestedValue ? 0 : requestedValue;
    try {
      await api("/api/public/votes", {
        method: "POST",
        body: JSON.stringify({ questionId, voterId, value }),
      });
      await loadQuestions(event?.id ?? "");
    } catch (voteError) {
      setError(getErrorMessage(voteError));
    }
  }

  if (loading && !event) {
    return <PageShell><Notice>{strings.loading}</Notice></PageShell>;
  }

  if (!event) {
    return <PageShell><Notice tone="error">{error ?? "Event not found."}</Notice></PageShell>;
  }

  const accentStyle = { "--event-accent": event.accentColor } as React.CSSProperties;
  const intro = event.introText || strings.defaultIntro;
  const askLabel = event.askButtonLabel || strings.askQuestion;
  const footerLabel = event.footerLabel || strings.defaultFooter;
  const footerUrl = event.footerUrl || "https://preguntaya.com";

  return (
    <main className="public-shell" style={accentStyle}>
      <header className="public-topbar">
        <BrandMark compact />
        <div className="event-meta">
          <strong>{event.title}</strong>
          <span>{[event.dateLabel, event.locationLabel].filter(Boolean).join(" / ")}</span>
        </div>
        <button className="theme-button" type="button" aria-label="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>
      </header>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <section className="public-intro">
        <p>{intro}</p>
        <button className="primary-button" type="button" onClick={() => setSheetOpen(true)}>
          <Icon name="plus" />
          {askLabel}
        </button>
      </section>

      <TalkRail talks={event.talks} selectedTalk={selectedTalk} onSelect={setSelectedTalk} language={event.language} />
      <QuestionFilters value={filter} onChange={setFilter} language={event.language} />
      <section className="public-questions" aria-label="Questions">
        {questions.map((question) => (
          <QuestionCard key={question.id} question={question} language={event.language} onVote={vote} />
        ))}
        {!questions.length ? <div className="empty-list">{strings.empty}</div> : null}
      </section>

      <a className="footer-cta" href={footerUrl} target="_blank" rel="noreferrer">
        <span>{footerLabel}</span>
        <strong>{formatUrl(footerUrl) || strings.publicFooterUrl}</strong>
      </a>

      {sheetOpen ? (
        <QuestionSheet event={event} onClose={() => setSheetOpen(false)} onSubmit={submitQuestion} />
      ) : null}
    </main>
  );
}

function QuestionSheet({
  event,
  onClose,
  onSubmit,
}: {
  event: PublicEvent;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const strings = eventCopy(event.language);
  const defaultTalk = event.talks[0]?.id ?? "";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="question-sheet" role="dialog" aria-modal="true" aria-labelledby="new-question-title" onClick={(click) => click.stopPropagation()}>
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-head">
          <h2 id="new-question-title">{strings.askQuestionShort}</h2>
          <button className="icon-button" type="button" aria-label={strings.close} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <form className="question-form" onSubmit={onSubmit}>
          <fieldset className="sheet-talks">
            <legend>{strings.talk}</legend>
            {event.talks.map((talk) => (
              <label className="sheet-talk-option" key={talk.id}>
                <input type="radio" name="talkId" value={talk.id} defaultChecked={talk.id === defaultTalk} required />
                <span>
                  <strong>{talk.title}</strong>
                  <small>{[talk.speakers, talk.role].filter(Boolean).join(" / ")}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <label>
            {strings.question}
            <textarea name="body" rows={4} minLength={8} maxLength={280} placeholder={strings.questionPlaceholder} required />
          </label>
          <label>
            {strings.nameOptional}
            <input name="authorName" maxLength={80} placeholder={strings.namePlaceholder} />
          </label>
          <button className="primary-button" type="submit">
            <Icon name="send" />
            {strings.send}
          </button>
        </form>
      </section>
    </div>
  );
}

function TalkRail({
  talks,
  selectedTalk,
  onSelect,
  language,
}: {
  talks: Talk[];
  selectedTalk: string;
  onSelect: (id: string) => void;
  language: Language;
}) {
  const strings = eventCopy(language);
  return (
    <section className="talk-rail" aria-label="Talks">
      <button className={selectedTalk === "all" ? "selected" : ""} type="button" onClick={() => onSelect("all")}>
        <strong>{strings.allTalks}</strong>
        <small>{talks.length} {strings.allTalksCount}</small>
      </button>
      {talks.map((talk) => (
        <button className={selectedTalk === talk.id ? "selected" : ""} key={talk.id} type="button" onClick={() => onSelect(talk.id)}>
          <strong>{talk.title}</strong>
          <small>{talk.speakers}</small>
        </button>
      ))}
    </section>
  );
}

function QuestionFilters({
  value,
  onChange,
  language,
}: {
  value: "open" | "answered" | "all";
  onChange: (value: "open" | "answered" | "all") => void;
  language: Language;
}) {
  const strings = eventCopy(language);
  const filters: Array<["open" | "answered" | "all", string]> = [
    ["open", strings.open],
    ["answered", strings.answered],
    ["all", strings.all],
  ];

  return (
    <nav className="question-filters" aria-label="Question filters">
      {filters.map(([key, label]) => (
        <button key={key} className={value === key ? "active" : ""} type="button" onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </nav>
  );
}

function QuestionCard({
  question,
  language,
  onVote,
}: {
  question: Question;
  language: Language;
  onVote: (questionId: string, value: number) => void;
}) {
  const strings = eventCopy(language);
  return (
    <article className="question-card">
      <div className="vote-stack">
        <button className={question.userVote === 1 ? "active" : ""} type="button" aria-label="Upvote" onClick={() => onVote(question.id, 1)}>
          <Icon name="chevron-up" />
        </button>
        <strong>{question.score}</strong>
        <button className={question.userVote === -1 ? "active" : ""} type="button" aria-label="Downvote" onClick={() => onVote(question.id, -1)}>
          <Icon name="chevron-down" />
        </button>
      </div>
      <div className="question-body">
        <div className="question-meta">
          <span>{question.talkTitle ?? ""}</span>
          {question.status === "answered" ? <mark>{strings.answered}</mark> : null}
        </div>
        <p>{question.body}</p>
        <footer>
          <span>{question.authorName || strings.anonymous}</span>
          <time>{formatTime(question.createdAt, language)}</time>
        </footer>
      </div>
    </article>
  );
}

function PageShell({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <main className={`page-shell ${className}`}>{children}</main>;
}

function Notice({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "error" | "success" }) {
  return <div className={`notice ${tone}`}>{children}</div>;
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand-mark ${compact ? "compact" : ""}`}>
      <span>?</span>
      <strong>PreguntaYa</strong>
    </div>
  );
}

function Icon({ name }: { name: "plus" | "send" | "x" | "chevron-up" | "chevron-down" | "moon" | "sun" | "trash" }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    send: <><path d="m4 12 16-8-5 16-3-7-8-1Z" /><path d="m12 13 8-9" /></>,
    x: <path d="M18 6 6 18M6 6l12 12" />,
    "chevron-up": <path d="m7 15 5-5 5 5" />,
    "chevron-down": <path d="m7 9 5 5 5-5" />,
    moon: <path d="M12 3a6.5 6.5 0 0 0 8.7 8.7A8.5 8.5 0 1 1 12 3Z" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></>,
    trash: <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></>,
  };

  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function toOwnerPayload(event: EventDetail): OwnerEventPayload {
  return {
    title: event.title,
    slug: event.slug,
    dateLabel: event.dateLabel,
    locationLabel: event.locationLabel,
    language: event.language,
    introText: event.introText,
    askButtonLabel: event.askButtonLabel,
    footerLabel: event.footerLabel,
    footerUrl: event.footerUrl,
    accentColor: event.accentColor || defaultAccent,
    isPublished: event.isPublished,
    isArchived: event.isArchived,
  };
}

function newTalk(position: number): Talk {
  return {
    id: crypto.randomUUID(),
    title: "New talk",
    speakers: "",
    role: "",
    position,
  };
}

function updateTalk(talks: Talk[], setTalks: (talks: Talk[]) => void, id: string, patch: Partial<Talk>) {
  setTalks(talks.map((talk) => (talk.id === id ? { ...talk, ...patch } : talk)));
}

function getOrCreateVoterId() {
  const key = "preguntaya-voter-id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}

function getInitialTheme(): "light" | "dark" {
  const stored = localStorage.getItem("preguntaya-theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function formatTime(value: string, language: Language) {
  return new Intl.DateTimeFormat(language === "es" ? "es-CL" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatUrl(value: string) {
  try {
    return new URL(value).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}
