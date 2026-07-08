import QRCode from "qrcode";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, getErrorMessage } from "./api";
import { eventCopy } from "./copy";
import { signInWithGoogle, signOutOfSupabase } from "./supabase";
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

type CreateEventPayload = {
  title: string;
  dateLabel: string;
  locationLabel: string;
  language: Language;
  talks: WizardTalk[];
};

type WizardTalk = {
  id: string;
  title: string;
  speakers: string;
  role: string;
};

type OwnerTab = "questions" | "share" | "settings";
type OwnerQuestionFilter = QuestionStatus | "all";

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
    return <AuthScreen />;
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

function AuthScreen() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loginWithGoogle() {
    setError(null);
    setLoading(true);

    try {
      await signInWithGoogle();
    } catch (authError) {
      setError(getErrorMessage(authError));
      setLoading(false);
    }
  }

  return (
    <PageShell className="auth-shell">
      <section className="auth-landing" aria-labelledby="auth-title">
        <div className="auth-story">
          <BrandMark />
          <div className="auth-copy">
            <p className="auth-kicker">For rooms that want better questions</p>
            <h1 id="auth-title">Live Q&A, ready before the room fills.</h1>
            <p>Create an event, share the QR, and let every attendee ask from the phone already in their hand.</p>
          </div>
          <div className="auth-actions">
            {error ? <Notice tone="error">{error}</Notice> : null}
            <button className="primary-button google-button" type="button" disabled={loading} onClick={loginWithGoogle}>
              <span className="google-mark" aria-hidden="true">G</span>
              {loading ? "Redirecting..." : "Continue with Google"}
            </button>
            <p>Organizer sign-in only. Attendees never need an account.</p>
          </div>
        </div>

        <figure className="auth-visual">
          <img
            src="https://images.unsplash.com/photo-1505373877841-8d25f7d46678?auto=format&fit=crop&w=1600&q=80"
            alt="An audience gathered for a conference session in a bright event room."
          />
          <figcaption>
            <span aria-hidden="true" />
            Questions are already coming in.
          </figcaption>
          <div className="auth-phone-preview" aria-hidden="true">
            <div className="phone-topline">
              <span>Live now</span>
              <strong>8 questions</strong>
            </div>
            <p>How do we keep the energy after the first question?</p>
            <div className="phone-vote-row">
              <span>24 votes</span>
              <span>Next up</span>
            </div>
          </div>
        </figure>
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
  const [wizardOpen, setWizardOpen] = useState(false);

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

  function handleEventCreated(event: EventSummary) {
    setEvents((current) => [event, ...current.filter((item) => item.id !== event.id)]);
  }

  async function logout() {
    await signOutOfSupabase().catch(() => undefined);
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    onLogout();
    window.history.replaceState(null, "", "/");
  }

  return (
    <div className="owner-shell">
      <aside className="owner-sidebar">
        <div className="sidebar-top">
          <BrandMark />
          <button className="icon-button" type="button" aria-label="Create event" onClick={() => setWizardOpen(true)}>
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
        {!route.eventId && !loading ? <EmptyWorkspace onCreate={() => setWizardOpen(true)} /> : null}
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
      {wizardOpen ? (
        <CreateEventWizard
          onClose={() => setWizardOpen(false)}
          onCreated={handleEventCreated}
          navigate={(eventId) => navigate({ kind: "owner", eventId })}
        />
      ) : null}
    </div>
  );
}

function EmptyWorkspace({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="empty-workspace">
      <h1>Create your event in under a minute</h1>
      <p>Add a title, keep the defaults, and AskStage gives you a QR code ready to share.</p>
      <button className="primary-button" type="button" onClick={onCreate}>
        <Icon name="plus" />
        New event
      </button>
    </section>
  );
}

function CreateEventWizard({
  onClose,
  onCreated,
  navigate,
}: {
  onClose: () => void;
  onCreated: (event: EventSummary) => void;
  navigate: (eventId: string) => void;
}) {
  const [step, setStep] = useState<"basics" | "talks" | "share">("basics");
  const [payload, setPayload] = useState<CreateEventPayload>({
    title: "",
    dateLabel: "",
    locationLabel: "",
    language: getDefaultLanguage(),
    talks: [],
  });
  const [createdEvent, setCreatedEvent] = useState<EventSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  function updatePayload<K extends keyof CreateEventPayload>(key: K, value: CreateEventPayload[K]) {
    setPayload((current) => ({ ...current, [key]: value }));
  }

  async function createEvent() {
    if (!payload.title.trim()) {
      setError("Event title is required.");
      setStep("basics");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const talks = payload.talks
        .map((talk) => ({
          title: talk.title.trim(),
          speakers: talk.speakers.trim(),
          role: talk.role.trim(),
        }))
        .filter((talk) => talk.title);
      const data = await api<{ event: EventSummary }>("/api/owner/events", {
        method: "POST",
        body: JSON.stringify({ ...payload, talks }),
      });
      setCreatedEvent(data.event);
      onCreated(data.event);
      setStep("share");
    } catch (createError) {
      setError(getErrorMessage(createError));
    } finally {
      setCreating(false);
    }
  }

  const publicUrl = createdEvent ? `${window.location.origin}/e/${createdEvent.slug}` : "";

  return (
    <div className="modal-backdrop wizard-backdrop" onClick={onClose}>
      <section className="event-wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title" onClick={(click) => click.stopPropagation()}>
        <div className="wizard-topline">
          <BrandMark />
          <button className="icon-button" type="button" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <nav className="wizard-steps" aria-label="Create event steps">
          <span className={step === "basics" ? "active" : ""}>Basics</span>
          <span className={step === "talks" ? "active" : ""}>Sessions</span>
          <span className={step === "share" ? "active" : ""}>Share</span>
        </nav>
        {error ? <Notice tone="error">{error}</Notice> : null}

        {step === "basics" ? (
          <form
            className="wizard-panel"
            onSubmit={(event) => {
              event.preventDefault();
              setStep("talks");
            }}
          >
            <div className="wizard-copy">
              <h1 id="wizard-title">What are you hosting?</h1>
              <p>Start with the only detail attendees need. Everything else can be tuned later.</p>
            </div>
            <label className="hero-field">
              Event title
              <input
                value={payload.title}
                autoFocus
                onChange={(input) => updatePayload("title", input.currentTarget.value)}
                placeholder="Design meetup, July demo night..."
                required
              />
            </label>
            <div className="two-field-row">
              <label>
                Date
                <input value={payload.dateLabel} onChange={(input) => updatePayload("dateLabel", input.currentTarget.value)} placeholder="Thu, Aug 6" />
              </label>
              <label>
                Location
                <input value={payload.locationLabel} onChange={(input) => updatePayload("locationLabel", input.currentTarget.value)} placeholder="Main stage" />
              </label>
            </div>
            <div className="segmented-field" role="radiogroup" aria-label="Event language">
              <button className={payload.language === "en" ? "active" : ""} type="button" onClick={() => updatePayload("language", "en")}>
                English
              </button>
              <button className={payload.language === "es" ? "active" : ""} type="button" onClick={() => updatePayload("language", "es")}>
                Espanol
              </button>
            </div>
            <div className="wizard-actions">
              <button className="primary-button" type="submit">Continue</button>
            </div>
          </form>
        ) : null}

        {step === "talks" ? (
          <div className="wizard-panel">
            <div className="wizard-copy">
              <h1>Sessions</h1>
              <p>Does your event have multiple talks? Add them so questions arrive organized.</p>
            </div>
            <div className="wizard-talks">
              {payload.talks.map((talk, index) => (
                <article className="wizard-talk-row" key={talk.id}>
                  <span className="row-number">{index + 1}</span>
                  <label>
                    Title
                    <input
                      value={talk.title}
                      onChange={(input) => updateWizardTalk(payload, updatePayload, talk.id, { title: input.currentTarget.value })}
                      placeholder="Opening keynote"
                    />
                  </label>
                  <label>
                    Speakers
                    <input
                      value={talk.speakers}
                      onChange={(input) => updateWizardTalk(payload, updatePayload, talk.id, { speakers: input.currentTarget.value })}
                      placeholder="Name, name"
                    />
                  </label>
                  <button
                    className="icon-button danger"
                    type="button"
                    aria-label="Remove session"
                    onClick={() => updatePayload("talks", payload.talks.filter((item) => item.id !== talk.id))}
                  >
                    <Icon name="trash" />
                  </button>
                </article>
              ))}
              {!payload.talks.length ? <div className="empty-list">Skip this and AskStage creates a main session for you.</div> : null}
            </div>
            <button className="secondary-button" type="button" onClick={() => updatePayload("talks", [...payload.talks, newWizardTalk()])}>
              <Icon name="plus" />
              Add session
            </button>
            <div className="wizard-actions split">
              <button className="text-button" type="button" onClick={() => setStep("basics")}>Back</button>
              <div>
                <button className="secondary-button" type="button" disabled={creating} onClick={createEvent}>Skip this step</button>
                <button className="primary-button" type="button" disabled={creating} onClick={createEvent}>
                  {creating ? "Creating..." : "Create and show QR"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {step === "share" && createdEvent ? (
          <div className="wizard-panel share-success">
            <div className="wizard-copy">
              <h1>Ready to share</h1>
              <p>Your event is live. Put this QR on screen and let the audience ask from their phones.</p>
            </div>
            <QRShareCard title={createdEvent.title} publicUrl={publicUrl} large />
            <div className="wizard-actions split">
              <button className="text-button" type="button" onClick={() => navigate(createdEvent.id)}>Personalize more</button>
              <div>
                <a className="secondary-button" href={publicUrl} target="_blank" rel="noreferrer">
                  <Icon name="external" />
                  Public page
                </a>
                <button className="primary-button" type="button" onClick={onClose}>Done</button>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
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
  const [activeTab, setActiveTab] = useState<OwnerTab>("questions");
  const [questionFilter, setQuestionFilter] = useState<OwnerQuestionFilter>("open");
  const [selectedTalk, setSelectedTalk] = useState("all");
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
    if (!event) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void loadQuestions();
    };
    const interval = window.setInterval(refresh, 12000);
    return () => window.clearInterval(interval);
  }, [eventId, event]);

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

  const openCount = questions.filter((question) => question.status === "open").length;
  const visibleQuestions = questions.filter((question) => {
    const matchesStatus = questionFilter === "all" || question.status === questionFilter;
    const matchesTalk = selectedTalk === "all" || question.talkId === selectedTalk;
    return matchesStatus && matchesTalk;
  });

  return (
    <div className="event-workspace">
      <section className="event-hero">
        <div>
          <p className="overline">{event.isPublished ? "Published" : "Draft"}</p>
          <h1>{event.title}</h1>
          <p>{[event.dateLabel, event.locationLabel].filter(Boolean).join(" / ") || "Ready for live Q&A"}</p>
        </div>
        <a className="secondary-button" href={publicUrl} target="_blank" rel="noreferrer">
          <Icon name="external" />
          Open public page
        </a>
      </section>

      <nav className="workspace-tabs" aria-label="Event workspace">
        {([
          ["questions", `Questions (${openCount})`],
          ["share", "Share"],
          ["settings", "Settings"],
        ] as Array<[OwnerTab, string]>).map(([key, label]) => (
          <button key={key} className={activeTab === key ? "active" : ""} type="button" onClick={() => setActiveTab(key)}>
            {label}
          </button>
        ))}
      </nav>

      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      {activeTab === "questions" ? (
        <section className="live-questions">
          <div className="section-head compact">
            <div>
              <h2>Live questions</h2>
              <p>Moderate what appears on stage. Refreshes automatically while this tab is visible.</p>
            </div>
            <button className="secondary-button" type="button" onClick={() => void loadQuestions()}>
              <Icon name="refresh" />
              Refresh
            </button>
          </div>

          <div className="moderation-toolbar">
            <nav className="question-filters owner-filters" aria-label="Question filters">
              {([
                ["open", "Open"],
                ["answered", "Answered"],
                ["hidden", "Hidden"],
                ["all", "All"],
              ] as Array<[OwnerQuestionFilter, string]>).map(([key, label]) => (
                <button key={key} className={questionFilter === key ? "active" : ""} type="button" onClick={() => setQuestionFilter(key)}>
                  {label}
                </button>
              ))}
            </nav>
            {talks.length > 1 ? (
              <select value={selectedTalk} onChange={(input) => setSelectedTalk(input.currentTarget.value)} aria-label="Filter by session">
                <option value="all">All sessions</option>
                {talks.map((talk) => (
                  <option key={talk.id} value={talk.id}>{talk.title}</option>
                ))}
              </select>
            ) : null}
          </div>

          <div className="question-admin-list">
            {visibleQuestions.map((question) => (
              <article className={`admin-question-card status-${question.status} ${question.pinned ? "pinned" : ""}`} key={question.id}>
                <div>
                  <span>{question.talkTitle ?? "Deleted session"}</span>
                  <p>{question.body}</p>
                  <small>{question.score} votes / {question.status}{question.pinned ? " / pinned" : ""}</small>
                </div>
                <div className="admin-actions">
                  <button type="button" onClick={() => void updateQuestion(question.id, { pinned: !question.pinned })}>
                    <Icon name="pin" />
                    {question.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button type="button" onClick={() => void updateQuestion(question.id, { status: question.status === "answered" ? "open" : "answered" })}>
                    <Icon name="check" />
                    {question.status === "answered" ? "Reopen" : "Answered"}
                  </button>
                  <button type="button" onClick={() => void updateQuestion(question.id, { status: question.status === "hidden" ? "open" : "hidden", pinned: false })}>
                    <Icon name="eye-off" />
                    {question.status === "hidden" ? "Show" : "Hide"}
                  </button>
                </div>
              </article>
            ))}
            {!visibleQuestions.length ? <div className="empty-list">No questions in this view.</div> : null}
          </div>
        </section>
      ) : null}

      {activeTab === "share" ? (
        <section className="editor-main-card share-view">
          <div className="section-head compact">
            <div>
              <h2>Share AskStage</h2>
              <p>Use this link or QR code anywhere attendees can scan it.</p>
            </div>
          </div>
          <QRShareCard title={event.title} publicUrl={publicUrl} large />
        </section>
      ) : null}

      {activeTab === "settings" ? (
        <section className="editor-main-card settings-view">
          <div className="section-head">
          <div>
              <h2>Settings</h2>
              <p>Defaults stay out of the creation flow. Tune details here only when you need them.</p>
            </div>
            <button className="primary-button" type="submit" form="event-settings-form">Save event</button>
          </div>

          <form id="event-settings-form" className="settings-grid" onSubmit={saveEvent}>
            <h3>Basic information</h3>
          <label className="wide-field">
            Event title
            <input value={draft.title} onChange={(input) => updateDraft("title", input.currentTarget.value)} required />
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
            <h3>Appearance and copy</h3>
          <label>
            Accent color
            <span className="color-field">
              <input type="color" value={draft.accentColor} onChange={(input) => updateDraft("accentColor", input.currentTarget.value)} />
              <input value={draft.accentColor} onChange={(input) => updateDraft("accentColor", input.currentTarget.value)} />
            </span>
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
            <h3>Advanced</h3>
            <label>
              Public slug
              <input value={draft.slug} onChange={(input) => updateDraft("slug", input.currentTarget.value)} required />
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
          <div className="form-actions">
            <button className="primary-button" type="submit">Save event</button>
          </div>
        </form>

          <div className="talk-editor">
        <div className="section-head compact">
          <div>
                <h3>Sessions</h3>
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
        </div>
      </section>
      ) : null}
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
  const [submitted, setSubmitted] = useState(false);
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
    if (!event) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void loadQuestions(event.id);
    };
    const interval = window.setInterval(refresh, 12000);
    return () => window.clearInterval(interval);
  }, [event, filter, selectedTalk]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("askstage-theme", theme);
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
      setSubmitted(true);
      await loadQuestions(event.id);
      window.setTimeout(() => setSubmitted(false), 2600);
    } catch (submitError) {
      setError(getErrorMessage(submitError));
    }
  }

  async function vote(questionId: string, requestedValue: number) {
    const current = questions.find((question) => question.id === questionId)?.userVote ?? 0;
    const value = current === requestedValue ? 0 : requestedValue;
    setQuestions((items) =>
      items.map((question) => {
        if (question.id !== questionId) return question;
        return { ...question, score: question.score - current + value, userVote: value };
      }),
    );
    try {
      await api("/api/public/votes", {
        method: "POST",
        body: JSON.stringify({ questionId, voterId, value }),
      });
      await loadQuestions(event?.id ?? "");
    } catch (voteError) {
      setError(getErrorMessage(voteError));
      await loadQuestions(event?.id ?? "");
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
  const footerUrl = event.footerUrl || "https://askstage.com";
  const eventMeta = [event.dateLabel, event.locationLabel].filter(Boolean).join(" / ");

  return (
    <main className="public-shell" style={accentStyle}>
      <header className="public-topbar">
        <BrandMark compact />
        <div className="event-meta">
          <strong>{event.title}</strong>
          <span>{eventMeta}</span>
        </div>
        <button className="theme-button" type="button" aria-label="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>
      </header>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {submitted ? <Notice tone="success">Question sent.</Notice> : null}

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

function QRShareCard({ title, publicUrl, large = false }: { title: string; publicUrl: string; large?: boolean }) {
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!publicUrl) return;
    void QRCode.toDataURL(publicUrl, {
      width: large ? 320 : 220,
      margin: 1,
      color: { dark: "#17130f", light: "#ffffff" },
    }).then(setQr);
  }, [publicUrl, large]);

  async function copyLink() {
    await navigator.clipboard.writeText(publicUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function downloadQr() {
    const dataUrl = await QRCode.toDataURL(publicUrl, {
      width: 1024,
      margin: 2,
      color: { dark: "#17130f", light: "#ffffff" },
    });
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `${slugifyFileName(title)}-askstage-qr.png`;
    link.click();
  }

  return (
    <div className={`qr-share-card ${large ? "large" : ""}`}>
      <div className="qr-frame">{qr ? <img src={qr} alt={`QR code for ${title}`} /> : <span>Generating QR...</span>}</div>
      <code>{publicUrl}</code>
      <div className="share-actions">
        <button className="secondary-button" type="button" onClick={() => void copyLink()}>
          <Icon name="copy" />
          {copied ? "Copied" : "Copy link"}
        </button>
        <button className="secondary-button" type="button" onClick={() => void downloadQr()}>
          <Icon name="download" />
          Download QR
        </button>
      </div>
    </div>
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
      <strong>AskStage</strong>
    </div>
  );
}

function Icon({ name }: { name: "plus" | "send" | "x" | "chevron-up" | "chevron-down" | "moon" | "sun" | "trash" | "external" | "refresh" | "pin" | "check" | "eye-off" | "copy" | "download" }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    send: <><path d="m4 12 16-8-5 16-3-7-8-1Z" /><path d="m12 13 8-9" /></>,
    x: <path d="M18 6 6 18M6 6l12 12" />,
    "chevron-up": <path d="m7 15 5-5 5 5" />,
    "chevron-down": <path d="m7 9 5 5 5-5" />,
    moon: <path d="M12 3a6.5 6.5 0 0 0 8.7 8.7A8.5 8.5 0 1 1 12 3Z" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></>,
    trash: <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></>,
    external: <><path d="M14 3h7v7" /><path d="M10 14 21 3" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" /></>,
    refresh: <><path d="M21 12a9 9 0 0 1-15.3 6.4" /><path d="M3 12A9 9 0 0 1 18.3 5.6" /><path d="M3 17v-5h5" /><path d="M21 7v5h-5" /></>,
    pin: <><path d="M12 17v5" /><path d="m5 9 10-6 6 6-6 10-4-4-4 4-2-2 4-4-4-4Z" /></>,
    check: <path d="m20 6-11 11-5-5" />,
    "eye-off": <><path d="M3 3l18 18" /><path d="M10.6 10.6A2 2 0 0 0 13.4 13.4" /><path d="M9.9 4.2A10.8 10.8 0 0 1 12 4c5 0 9 4.5 10 8a12.8 12.8 0 0 1-2.1 3.7" /><path d="M6.6 6.6C4.8 7.8 3.3 9.7 2 12c1 3.5 5 8 10 8 1.4 0 2.8-.4 4-1" /></>,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
    download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
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

function newWizardTalk(): WizardTalk {
  return {
    id: crypto.randomUUID(),
    title: "",
    speakers: "",
    role: "",
  };
}

function updateWizardTalk(
  payload: CreateEventPayload,
  updatePayload: <K extends keyof CreateEventPayload>(key: K, value: CreateEventPayload[K]) => void,
  id: string,
  patch: Partial<WizardTalk>,
) {
  updatePayload(
    "talks",
    payload.talks.map((talk) => (talk.id === id ? { ...talk, ...patch } : talk)),
  );
}

function getDefaultLanguage(): Language {
  return navigator.language.toLowerCase().startsWith("es") ? "es" : "en";
}

function getOrCreateVoterId() {
  const key = "askstage-voter-id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}

function getInitialTheme(): "light" | "dark" {
  const stored = localStorage.getItem("askstage-theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function slugifyFileName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "event";
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
