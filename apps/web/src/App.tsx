import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Character, ChatMessage, ChatResponse, ChatTask, ConversationSummary } from "@let-us-talk/shared";
import { io, type Socket } from "socket.io-client";
import {
  Avatar,
  ChatContainer,
  Conversation,
  ConversationHeader,
  ConversationList,
  MainContainer,
  Message,
  MessageInput,
  MessageList,
  Sidebar,
  TypingIndicator,
} from "@chatscope/chat-ui-kit-react";

interface RetryRequest {
  content: string;
  messageId: string;
}

interface RealtimeCompleted {
  eventId?: string;
  conversationId: string;
  messageId: string;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}

interface RealtimeFailed {
  eventId?: string;
  conversationId: string;
  messageId: string;
  userMessage: ChatMessage;
  task?: ChatTask;
  error: string;
}

interface OutboxItem {
  characterId: string;
  conversationId: string;
  content: string;
  messageId: string;
}

interface AuthUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
}

const fallbackCharacters: Character[] = [
  { id: "momo", name: "Momo", avatar: "🌙", tagline: "温柔、细腻，喜欢听你慢慢说", systemPrompt: "" },
  { id: "loki", name: "Loki", avatar: "🦊", tagline: "有点毒舌，但总是站在你这边", systemPrompt: "" },
  { id: "nora", name: "Nora", avatar: "☕", tagline: "理性又好奇，什么都愿意聊", systemPrompt: "" },
];

function avatarSource(character: Pick<Character, "name" | "avatar">) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="#eee5d7"/><text x="48" y="62" text-anchor="middle" font-size="42">${character.avatar}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function userFacingError(error: unknown, fallback: string) {
  if (error instanceof TypeError) return "网络连接失败，请稍后重试";
  return error instanceof Error ? error.message : fallback;
}

function sendRealtimeMessage(socket: Socket, payload: { characterId: string; conversationId: string; content: string; messageId: string }, seenEventIds: Set<string>) {
  return new Promise<ChatResponse>((resolve, reject) => {
    let acknowledged = false;
    const cleanup = () => {
      socket.off("chat:completed", onCompleted);
      socket.off("chat:failed", onFailed);
      socket.off("disconnect", onDisconnect);
    };
    const onCompleted = (event: RealtimeCompleted) => {
      if (!acknowledged || event.messageId !== payload.messageId) return;
      if (event.eventId && seenEventIds.has(event.eventId)) return;
      if (event.eventId) seenEventIds.add(event.eventId);
      cleanup();
      resolve({ userMessage: event.userMessage, assistantMessage: event.assistantMessage });
    };
    const onFailed = (event: RealtimeFailed) => {
      if (!acknowledged || event.messageId !== payload.messageId) return;
      if (event.eventId && seenEventIds.has(event.eventId)) return;
      if (event.eventId) seenEventIds.add(event.eventId);
      cleanup();
      reject(new Error(event.error));
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error("网络连接失败，请稍后重试"));
    };
    socket.on("chat:completed", onCompleted);
    socket.on("chat:failed", onFailed);
    socket.once("disconnect", onDisconnect);
    socket.emit("chat:send", payload, (acknowledgment: { ok: boolean; error?: string }) => {
      if (!acknowledgment.ok) {
        cleanup();
        reject(new Error(acknowledgment.error ?? "请求失败"));
        return;
      }
      acknowledged = true;
    });
  });
}

function outboxKey(userId: string) {
  return `let-us-talk:outbox:${userId}`;
}

function readOutbox(userId: string): OutboxItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(outboxKey(userId)) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed as OutboxItem[] : [];
  } catch {
    return [];
  }
}

function writeOutbox(userId: string, items: OutboxItem[]) {
  localStorage.setItem(outboxKey(userId), JSON.stringify(items));
}

function matchesClientMessage(message: ChatMessage, messageId: string) {
  return message.id === messageId || message.clientMessageId === messageId;
}

function localizeAuthError(data: { code?: string; message?: string; error?: string }) {
  const code = data.code?.toUpperCase();
  const message = `${data.message ?? ""} ${data.error ?? ""}`.toLowerCase();
  if (code === "INVALID_PASSWORD" || code === "USER_NOT_FOUND" || code === "INVALID_EMAIL_OR_PASSWORD" || message.includes("invalid password")) return "邮箱或密码错误";
  if (code === "USER_ALREADY_EXISTS" || code === "EMAIL_ALREADY_EXISTS" || message.includes("already exists")) return "该邮箱已注册，请直接登录";
  if (code === "EMAIL_NOT_VERIFIED") return "请先完成邮箱验证";
  if (code === "INVALID_TOKEN" || code === "TOKEN_EXPIRED" || message.includes("invalid token")) return "重置码无效或已过期";
  if (code === "INVALID_REDIRECT_URL") return "重置链接地址无效";
  if (code === "PASSWORD_TOO_SHORT") return "密码至少需要 8 位";
  return "请求失败，请稍后重试";
}

export function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [characters, setCharacters] = useState<Character[]>(fallbackCharacters);
  const [activePanel, setActivePanel] = useState<"conversations" | "contacts" | "settings">("contacts");
  const [conversationSummaries, setConversationSummaries] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState("momo");
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tasks, setTasks] = useState<ChatTask[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [retryRequest, setRetryRequest] = useState<RetryRequest | null>(null);
  const [clearing, setClearing] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileImage, setProfileImage] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState("");
  const selectedIdRef = useRef(selectedId);
  const selectedConversationIdRef = useRef(selectedConversationId);
  const socketRef = useRef<Socket | null>(null);
  const seenEventIdsRef = useRef(new Set<string>());
  const outboxRef = useRef<OutboxItem[]>([]);
  const loadedConversationKeyRef = useRef("");
  selectedIdRef.current = selectedId;
  selectedConversationIdRef.current = selectedConversationId;

  const selected = useMemo(
    () => characters.find((character) => character.id === selectedId) ?? fallbackCharacters[0],
    [characters, selectedId],
  );

  useEffect(() => {
    void fetch("/api/auth/get-session")
      .then(async (response) => {
        if (!response.ok) throw new Error("登录状态加载失败");
        return response.json() as Promise<{ user?: AuthUser } | null>;
      })
      .then((data) => setAuthUser(data?.user ?? null))
      .catch(() => setAuthUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (!authUser) return;
    void fetch("/api/characters")
      .then((response) => response.json())
      .then(setCharacters)
      .catch(() => undefined);
  }, [authUser]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!authUser || !socket?.connected || !selectedConversationId) return;
    socket.emit("conversation:join", { conversationId: selectedConversationId, characterId: selectedId });
  }, [authUser, selectedConversationId, selectedId]);

  useEffect(() => {
    if (!authUser) return;
    void fetch("/api/conversations")
      .then(async (response) => {
        if (!response.ok) throw new Error("会话列表加载失败");
        return response.json() as Promise<{ conversations?: ConversationSummary[] }>;
      })
      .then((data) => setConversationSummaries(data.conversations ?? []))
      .catch(() => setConversationSummaries([]));
  }, [authUser]);

  useEffect(() => {
    if (!authUser) return;
    outboxRef.current = readOutbox(authUser.id);
    seenEventIdsRef.current.clear();
    loadedConversationKeyRef.current = "";
    setTasks([]);
  }, [authUser]);

  useEffect(() => {
    if (!authUser) return;
    const socket = io({ withCredentials: true });
    socketRef.current = socket;
    const recover = () => {
      const conversationId = selectedConversationIdRef.current;
      if (!conversationId) return;
      socket.emit("conversation:join", { conversationId, characterId: selectedIdRef.current });
      void fetch(`/api/conversations/by-id/${conversationId}`)
        .then((response) => response.ok ? response.json() as Promise<{ messages?: ChatMessage[]; tasks?: ChatTask[] }> : undefined)
        .then((data) => {
          if (data) {
            setMessages(data.messages ?? []);
            setTasks(data.tasks ?? []);
          }
        })
        .catch(() => undefined);
    };
    socket.on("connect", recover);
    if (socket.connected) recover();
    return () => {
      socket.off("connect", recover);
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [authUser]);

  useEffect(() => {
    if (!authUser) return;
    const conversationKey = `${selectedId}:${selectedConversationId ?? "contact"}`;
    if (loadedConversationKeyRef.current === conversationKey) return;
    setMessages([]);
    setErrorMessage("");
    setRetryRequest(null);
    setLoadingConversation(true);
    let cancelled = false;
    const endpoint = selectedConversationId
      ? `/api/conversations/by-id/${selectedConversationId}`
      : `/api/conversations/${selectedId}`;
    void fetch(endpoint)
      .then(async (response) => {
        if (!response.ok) throw new Error("历史消息加载失败");
        return response.json() as Promise<{ conversation?: { id: string }; messages?: ChatMessage[]; tasks?: ChatTask[] }>;
      })
      .then((data) => {
        if (!cancelled) {
          loadedConversationKeyRef.current = `${selectedId}:${data.conversation?.id ?? selectedConversationId ?? "contact"}`;
          setSelectedConversationId(data.conversation?.id ?? selectedConversationId);
          const serverMessages = data.messages ?? [];
          const serverTasks = data.tasks ?? [];
          const reconciledOutbox = outboxRef.current.filter((item) => {
            const serverMessage = serverMessages.find((message) => matchesClientMessage(message, item.messageId));
            return !serverMessage || !serverTasks.some((task) => task.userMessageId === serverMessage.id && task.status === "completed");
          });
          outboxRef.current = reconciledOutbox;
          writeOutbox(authUser.id, reconciledOutbox);
          setMessages([...serverMessages, ...outboxRef.current
            .filter((item) => item.conversationId === data.conversation?.id && !serverMessages.some((message) => matchesClientMessage(message, item.messageId)))
            .map((item): ChatMessage => ({ id: item.messageId, clientMessageId: item.messageId, role: "user", content: item.content, createdAt: new Date().toISOString(), status: "failed" }))]);
          setTasks(serverTasks);
          const recoverable = outboxRef.current.find((item) => item.conversationId === data.conversation?.id);
          if (recoverable) setRetryRequest({ content: recoverable.content, messageId: recoverable.messageId });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setErrorMessage(userFacingError(error, "历史消息加载失败，请稍后重试"));
      })
      .finally(() => {
        if (!cancelled) setLoadingConversation(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authUser, selectedId, selectedConversationId]);

  async function refreshConversationSummaries() {
    const response = await fetch("/api/conversations");
    if (!response.ok) throw new Error("会话列表加载失败");
    const data = await response.json() as { conversations?: ConversationSummary[] };
    setConversationSummaries(data.conversations ?? []);
  }

  function selectContact(characterId: string) {
    setActivePanel("contacts");
    setSelectedConversationId(null);
    setSelectedId(characterId);
  }

  function openConversation(summary: ConversationSummary) {
    setActivePanel("conversations");
    setSelectedConversationId(summary.id);
    setSelectedId(summary.character.id);
  }

  async function logout() {
    await fetch("/api/auth/sign-out", { method: "POST" });
    setAuthUser(null);
    setMessages([]);
    setTasks([]);
  }

  function openProfile() {
    if (!authUser) return;
    setProfileName(authUser.name);
    setProfileImage(authUser.image ?? "");
    setProfileError("");
    setProfileOpen(true);
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profileName.trim()) return;
    setProfileSaving(true);
    setProfileError("");
    try {
      const response = await fetch("/api/auth/update-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: profileName.trim(), image: profileImage.trim() || null }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { message?: string; error?: string };
        throw new Error(data.error ?? data.message ?? "资料更新失败，请稍后重试");
      }
      const sessionResponse = await fetch("/api/auth/get-session");
      const session = await sessionResponse.json() as { user?: AuthUser } | null;
      if (session?.user) setAuthUser(session.user);
      setProfileOpen(false);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "资料更新失败，请稍后重试");
    } finally {
      setProfileSaving(false);
    }
  }

  async function sendMessage(value: string, messageId: string = crypto.randomUUID()) {
    const content = value.trim();
    if (!content || sending) return;

    const requestCharacterId = selectedId;
    const requestConversationId = selectedConversationId;

    setDraft("");
    setErrorMessage("");
    setRetryRequest(null);
    setSending(true);
    const userMessage: ChatMessage = {
      id: messageId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    const outboxItem: OutboxItem = {
      characterId: requestCharacterId,
      conversationId: requestConversationId ?? "",
      content,
      messageId: userMessage.id,
    };
    outboxRef.current = [...outboxRef.current.filter((item) => item.messageId !== userMessage.id), outboxItem];
    if (authUser) writeOutbox(authUser.id, outboxRef.current);
    setMessages((current) => [...current.filter((message) => !matchesClientMessage(message, userMessage.id)), userMessage]);

    try {
      let data: ChatResponse;
      const socket = socketRef.current;
      if (socket?.connected && requestConversationId) {
        data = await sendRealtimeMessage(socket, { characterId: requestCharacterId, conversationId: requestConversationId, content, messageId: userMessage.id }, seenEventIdsRef.current);
      } else {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ characterId: requestCharacterId, ...(requestConversationId ? { conversationId: requestConversationId } : {}), content, messageId: userMessage.id }),
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: "请求失败" }));
          throw new Error(error.error ?? "请求失败");
        }
        data = (await response.json()) as ChatResponse;
      }
      outboxRef.current = outboxRef.current.filter((item) => item.messageId !== userMessage.id);
      if (authUser) writeOutbox(authUser.id, outboxRef.current);
      if (selectedIdRef.current !== requestCharacterId) return;
      setRetryRequest(null);
      setMessages((current) => [
        ...current.filter((message) => !matchesClientMessage(message, userMessage.id)),
        data.userMessage,
        data.assistantMessage,
      ]);
      setTasks((current) => current.filter((task) => task.userMessageId !== data.userMessage.id && task.userMessageId !== userMessage.id));
      void refreshConversationSummaries().catch(() => undefined);
    } catch (error) {
      if (selectedIdRef.current !== requestCharacterId) return;
      setMessages((current) => current.map((message) => matchesClientMessage(message, userMessage.id) ? { ...message, status: "failed" } : message));
      setDraft(content);
      setRetryRequest({ content, messageId: userMessage.id });
      setErrorMessage(userFacingError(error, "网络连接失败，请稍后重试"));
    } finally {
      setSending(false);
    }
  }

  async function clearConversation() {
    if (sending || loadingConversation || clearing) return;

    const requestCharacterId = selectedId;
    setClearing(true);
    setErrorMessage("");
    setRetryRequest(null);
    try {
      const response = await fetch(`/api/conversations/${requestCharacterId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("会话清空失败，请稍后重试");
      if (selectedIdRef.current === requestCharacterId) setMessages([]);
      if (selectedIdRef.current === requestCharacterId) setTasks([]);
      void refreshConversationSummaries().catch(() => undefined);
    } catch (error) {
      if (selectedIdRef.current === requestCharacterId) {
        setErrorMessage(userFacingError(error, "会话清空失败，请稍后重试"));
      }
    } finally {
      setClearing(false);
    }
  }

  function retryTask(task: ChatTask) {
    const userMessage = messages.find((message) => message.id === task.userMessageId);
    const messageId = userMessage?.clientMessageId ?? userMessage?.id;
    if (userMessage && messageId) void sendMessage(userMessage.content, messageId);
  }

  if (authLoading) {
    return <div className="im-auth-loading">正在检查登录状态…</div>;
  }

  if (!authUser) {
    return <AuthScreen onAuthenticated={setAuthUser} />;
  }

  return (
    <div className="im-app">
      <MainContainer responsive className="im-container">
        <aside className="im-nav" aria-label="主导航">
          <div className="im-nav-mark" aria-hidden="true">✦</div>
          <nav>
            <button type="button" className={activePanel === "conversations" ? "im-nav-button im-nav-button-active" : "im-nav-button"} aria-label="会话" aria-pressed={activePanel === "conversations"} data-nav="conversations" onClick={() => setActivePanel("conversations")}>
              <span aria-hidden="true">◌</span>
              <small>会话</small>
            </button>
            <button type="button" className={activePanel === "contacts" ? "im-nav-button im-nav-button-active" : "im-nav-button"} aria-label="联系人" aria-pressed={activePanel === "contacts"} data-nav="contacts" onClick={() => setActivePanel("contacts")}>
              <span aria-hidden="true">♧</span>
              <small>联系人</small>
            </button>
            <button type="button" className={activePanel === "settings" ? "im-nav-button im-nav-button-active" : "im-nav-button"} aria-label="设置" aria-pressed={activePanel === "settings"} data-nav="settings" onClick={() => setActivePanel("settings")}>
              <span aria-hidden="true">⚙</span>
              <small>设置</small>
            </button>
          </nav>
        </aside>
        <Sidebar position="left" scrollable className="im-sidebar">
          <div className="im-brand">
            <div className="im-brand-mark">✦</div>
              <div>
                <strong>Let Us Talk</strong>
                <span>{authUser.name} · {authUser.email}</span>
              </div>
          </div>
          {activePanel === "conversations" && (
            <>
              <div className="im-section-title">会话</div>
              <ConversationList>
                {conversationSummaries.map((summary) => (
                  <Conversation
                    key={summary.id}
                    name={summary.character.name}
                    info={summary.lastMessagePreview}
                    active={summary.id === selectedConversationId}
                    data-conversation-id={summary.id}
                    data-character-id={summary.character.id}
                    onClick={() => openConversation(summary)}
                  >
                    <Avatar name={summary.character.name} src={avatarSource(summary.character)} />
                    <span className="im-conversation-time">{formatTime(summary.lastMessageAt)}</span>
                  </Conversation>
                ))}
              </ConversationList>
              {conversationSummaries.length === 0 && <div className="im-list-empty"><strong>还没有会话</strong><span>从联系人开始一段新的聊天</span></div>}
            </>
          )}
          {activePanel === "contacts" && (
            <>
              <div className="im-section-title">联系人</div>
              <ConversationList>
                {characters.map((character) => (
                  <Conversation
                    key={character.id}
                    name={character.name}
                    info={character.tagline}
                    active={character.id === selected.id}
                    data-character-id={character.id}
                    onClick={() => selectContact(character.id)}
                  >
                    <Avatar name={character.name} src={avatarSource(character)} />
                  </Conversation>
                ))}
              </ConversationList>
            </>
          )}
          {activePanel === "settings" && (
            <div className="im-settings-panel">
              <div className="im-section-title">设置</div>
              <div className="im-settings-user"><strong>{authUser.name}</strong><span>{authUser.email}</span></div>
              <button type="button" className="im-settings-action" onClick={openProfile}>账号资料</button>
              <button type="button" className="im-settings-action" onClick={() => setAboutOpen(true)}>关于与说明</button>
              <button type="button" className="im-settings-action im-settings-logout" onClick={() => void logout()}>退出登录</button>
            </div>
          )}
          <div className="im-sidebar-footer">
            <button className="im-about-button" type="button" onClick={openProfile}>账号资料</button>
            <span className="im-footer-separator">·</span>
            <button className="im-about-button" type="button" onClick={() => setAboutOpen(true)}>
              关于与说明
            </button>
          </div>
        </Sidebar>

        <ChatContainer className="im-chat-container">
          <ConversationHeader>
            <Avatar name={selected.name} src={avatarSource(selected)} status="available" />
            <ConversationHeader.Content userName={selected.name} info={selected.tagline} />
            <ConversationHeader.Actions>
              <button type="button" className="im-clear-button" onClick={() => void logout()}>退出登录</button>
              <button
                type="button"
                className="im-clear-button"
                aria-label="清空当前会话"
                onClick={() => void clearConversation()}
                disabled={sending || loadingConversation || clearing}
              >
                {clearing ? "正在清空…" : "清空会话"}
              </button>
            </ConversationHeader.Actions>
          </ConversationHeader>

          <MessageList
            autoScrollToBottom
            autoScrollToBottomOnMount
            scrollBehavior="smooth"
            typingIndicator={sending ? <TypingIndicator content="对方正在输入中…" /> : undefined}
          >
            {errorMessage && (
              <div className="im-error" role="alert">
                <span>{errorMessage}</span>
                {retryRequest && (
                  <button
                    type="button"
                    onClick={() => void sendMessage(retryRequest.content, retryRequest.messageId)}
                    disabled={sending}
                  >
                    重试发送
                  </button>
                )}
              </div>
            )}
            {!loadingConversation && !errorMessage && retryRequest && (
              <div className="im-task-state" role="alert">
                <span>有一条消息尚未完成对账</span>
                <button type="button" onClick={() => void sendMessage(retryRequest.content, retryRequest.messageId)} disabled={sending}>重试发送</button>
              </div>
            )}
            {(sending || clearing) && (
              <div className="im-send-status" role="status" aria-live="polite">
                {sending ? `正在等待 ${selected.name} 回复…` : "正在清空当前会话…"}
              </div>
            )}
            {loadingConversation && <div className="im-loading-state">正在加载历史消息…</div>}
            {!loadingConversation && tasks.filter((task) => task.status !== "completed").map((task) => {
              const taskMessage = messages.find((message) => message.id === task.userMessageId);
              return (
                <div className="im-task-state" key={task.id} data-task-id={task.id} role={task.status === "failed" ? "alert" : "status"}>
                  <span>{task.status === "waiting" ? "AI 回复排队中…" : task.status === "processing" ? "AI 正在处理中…" : `AI 回复失败：${task.error ?? "请重试"}`}</span>
                  {task.status === "failed" && taskMessage && <button type="button" onClick={() => retryTask(task)} disabled={sending}>重试回复</button>}
                </div>
              );
            })}
            {!loadingConversation && messages.length === 0 && (
              <div className="im-empty-state">
                <img src={avatarSource(selected)} alt="" />
                <strong>开始和 {selected.name} 聊天</strong>
                <span>{selected.tagline}</span>
              </div>
            )}
            {messages.map((message) => (
              <Message
                key={message.id}
                model={{
                  message: message.content || (sending && message.role === "assistant" ? "…" : ""),
                  sentTime: formatTime(message.createdAt),
                  sender: message.role === "assistant" ? selected.name : "我",
                  direction: message.role === "assistant" ? "incoming" : "outgoing",
                  position: "single",
                }}
              />
            ))}
          </MessageList>

          <MessageInput
            value={draft}
            onChange={(_innerHtml, textContent) => setDraft(textContent)}
            onSend={(_innerHtml, textContent) => void sendMessage(textContent)}
            placeholder={`给 ${selected.name} 发消息`}
            disabled={sending || loadingConversation || clearing}
            sendDisabled={sending || loadingConversation || clearing || !draft.trim()}
            sendOnReturnDisabled={false}
            attachButton={false}
            autoFocus
          />
        </ChatContainer>
      </MainContainer>
      {aboutOpen && (
        <div className="im-modal-backdrop" role="presentation">
          <section className="im-about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
            <div className="im-about-heading">
              <div>
                <span className="im-dialog-kicker">LET US TALK</span>
                <h2 id="about-title">关于与说明</h2>
              </div>
              <button type="button" aria-label="关闭关于说明" onClick={() => setAboutOpen(false)}>×</button>
            </div>
            <div className="im-about-copy">
              <h3>AI 身份</h3>
              <p>这里的联系人是由模型驱动的 AI 聊天伙伴，不是真人用户。</p>
              <h3>实验性质</h3>
              <p>这是一个用于验证私聊体验的实验性 MVP，回复可能不稳定，也不应替代专业建议。</p>
              <h3>MVP 限制</h3>
              <p>当前支持账号登录、固定联系人和文字私聊；暂不提供长期记忆、群聊或 AI 主动消息。</p>
            </div>
          </section>
        </div>
      )}
      {profileOpen && (
        <div className="im-modal-backdrop" role="presentation">
          <section className="im-about-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title">
            <div className="im-about-heading">
              <div><span className="im-dialog-kicker">ACCOUNT</span><h2 id="profile-title">账号资料</h2></div>
              <button type="button" aria-label="关闭账号资料" onClick={() => setProfileOpen(false)}>×</button>
            </div>
            <form className="im-profile-form" onSubmit={saveProfile}>
              <label>昵称<input value={profileName} onChange={(event) => setProfileName(event.target.value)} maxLength={50} required /></label>
              <label>头像地址<input type="url" value={profileImage} onChange={(event) => setProfileImage(event.target.value)} placeholder="https://…（可选）" /></label>
              {profileError && <div className="im-auth-error" role="alert">{profileError}</div>}
              <button className="im-auth-submit" type="submit" disabled={profileSaving}>{profileSaving ? "保存中…" : "保存资料"}</button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<"login" | "register" | "forgot" | "reset">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextFieldErrors: Record<string, string> = {};
    if (mode !== "reset" && (!email.trim() || !/^\S+@\S+\.\S+$/.test(email.trim()))) nextFieldErrors.email = "请输入有效的邮箱地址";
    if (mode === "register" && password.length < 8) nextFieldErrors.password = "密码至少需要 8 位";
    if (mode === "login" && !password) nextFieldErrors.password = "请输入密码";
    if (mode === "reset" && !token.trim()) nextFieldErrors.token = "请输入重置码";
    if (mode === "reset" && password.length < 8) nextFieldErrors.password = "新密码至少需要 8 位";
    setFieldErrors(nextFieldErrors);
    if (Object.keys(nextFieldErrors).length > 0) return;
    setSubmitting(true);
    setError("");
    setMessage("");
    const endpoint = mode === "login" ? "/api/auth/sign-in/email"
      : mode === "register" ? "/api/auth/sign-up/email"
        : mode === "forgot" ? "/api/auth/request-password-reset" : "/api/auth/reset-password";
    const body = mode === "login" || mode === "register"
      ? { email, password, ...(mode === "register" ? { name: name.trim() || email.split("@")[0] } : {}) }
      : mode === "forgot"
        ? { email, redirectTo: `${window.location.origin}/reset-password` }
        : { token, newPassword: password };
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({})) as { user?: AuthUser; code?: string; message?: string; error?: string };
      if (!response.ok) throw new Error(localizeAuthError(data));
      if (data.user) onAuthenticated(data.user);
      else setMessage(mode === "forgot" ? "如果邮箱已注册，重置链接已发送。" : "密码已重置，请使用新密码登录。");
      if (mode === "reset") setMode("login");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "请求失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  const title = mode === "login" ? "欢迎回来" : mode === "register" ? "创建账号" : mode === "forgot" ? "找回密码" : "重置密码";
  return (
    <main className="im-auth-page">
      <section className="im-auth-card">
        <div className="im-brand-mark">✦</div>
        <span className="im-dialog-kicker">LET US TALK</span>
        <h1>{title}</h1>
        <p className="im-auth-intro">登录后，和你的 AI 朋友继续聊天。</p>
        <form onSubmit={submit} noValidate>
          {mode === "register" && <label>昵称<input value={name} onChange={(event) => setName(event.target.value)} maxLength={50} /></label>}
          {mode !== "reset" && <label className={fieldErrors.email ? "im-field-error" : ""}>邮箱<input type="email" value={email} onChange={(event) => { setEmail(event.target.value); setFieldErrors((current) => ({ ...current, email: "" })); }} aria-invalid={Boolean(fieldErrors.email)} aria-describedby={fieldErrors.email ? "email-error" : undefined} autoComplete="email" />{fieldErrors.email && <span id="email-error" className="im-field-message">{fieldErrors.email}</span>}</label>}
          {mode === "reset" && <label className={fieldErrors.token ? "im-field-error" : ""}>重置码<input value={token} onChange={(event) => { setToken(event.target.value); setFieldErrors((current) => ({ ...current, token: "" })); }} aria-invalid={Boolean(fieldErrors.token)} aria-describedby={fieldErrors.token ? "token-error" : undefined} />{fieldErrors.token && <span id="token-error" className="im-field-message">{fieldErrors.token}</span>}</label>}
          {mode !== "forgot" && <label className={fieldErrors.password ? "im-field-error" : ""}>密码<input type="password" value={password} onChange={(event) => { setPassword(event.target.value); setFieldErrors((current) => ({ ...current, password: "" })); }} aria-invalid={Boolean(fieldErrors.password)} aria-describedby={fieldErrors.password ? "password-error" : undefined} autoComplete={mode === "login" ? "current-password" : "new-password"} />{fieldErrors.password && <span id="password-error" className="im-field-message">{fieldErrors.password}</span>}</label>}
          {error && <div className="im-auth-error" role="alert">{error}</div>}
          {message && <div className="im-auth-message" role="status">{message}</div>}
          <button className="im-auth-submit" type="submit" disabled={submitting}>{submitting ? "请稍候…" : title}</button>
        </form>
        <div className="im-auth-links">
          {mode === "login" && <><button type="button" onClick={() => setMode("register")}>创建账号</button><button type="button" onClick={() => setMode("forgot")}>忘记密码</button></>}
          {mode === "register" && <button type="button" onClick={() => setMode("login")}>已有账号，返回登录</button>}
          {mode === "forgot" && <><button type="button" onClick={() => setMode("reset")}>已有重置码</button><button type="button" onClick={() => setMode("login")}>返回登录</button></>}
          {mode === "reset" && <button type="button" onClick={() => setMode("login")}>返回登录</button>}
        </div>
      </section>
    </main>
  );
}
