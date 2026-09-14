import { useEffect, useMemo, useRef, useState } from "react";
import type { Character, ChatMessage, ChatResponse } from "@let-us-talk/shared";
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

const fallbackCharacters: Character[] = [
  { id: "momo", name: "Momo", avatar: "🌙", tagline: "温柔、细腻，喜欢听你慢慢说", systemPrompt: "" },
  { id: "loki", name: "Loki", avatar: "🦊", tagline: "有点毒舌，但总是站在你这边", systemPrompt: "" },
  { id: "nora", name: "Nora", avatar: "☕", tagline: "理性又好奇，什么都愿意聊", systemPrompt: "" },
];

function avatarSource(character: Character) {
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

export function App() {
  const [characters, setCharacters] = useState<Character[]>(fallbackCharacters);
  const [selectedId, setSelectedId] = useState("momo");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [retryRequest, setRetryRequest] = useState<RetryRequest | null>(null);
  const [clearing, setClearing] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => characters.find((character) => character.id === selectedId) ?? fallbackCharacters[0],
    [characters, selectedId],
  );

  useEffect(() => {
    void fetch("/api/characters")
      .then((response) => response.json())
      .then(setCharacters)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setMessages([]);
    setErrorMessage("");
    setRetryRequest(null);
    setLoadingConversation(true);
    let cancelled = false;
    void fetch(`/api/conversations/${selectedId}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("历史消息加载失败");
        return response.json() as Promise<{ messages?: ChatMessage[] }>;
      })
      .then((data) => {
        if (!cancelled) setMessages(data.messages ?? []);
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
  }, [selectedId]);

  async function sendMessage(value: string, messageId: string = crypto.randomUUID()) {
    const content = value.trim();
    if (!content || sending) return;

    const requestCharacterId = selectedId;

    setDraft("");
    setErrorMessage("");
    setRetryRequest(null);
    setSending(true);
    const userMessage: ChatMessage = {
      id: messageId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, userMessage]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: requestCharacterId, content, messageId: userMessage.id }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "请求失败" }));
        throw new Error(error.error ?? "请求失败");
      }
      const data = (await response.json()) as ChatResponse;
      if (selectedIdRef.current !== requestCharacterId) return;
      setRetryRequest(null);
      setMessages((current) => [
        ...current.filter((message) => message.id !== userMessage.id),
        data.userMessage,
        data.assistantMessage,
      ]);
    } catch (error) {
      if (selectedIdRef.current !== requestCharacterId) return;
      setMessages((current) => current.filter((message) => message.id !== userMessage.id));
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
    } catch (error) {
      if (selectedIdRef.current === requestCharacterId) {
        setErrorMessage(userFacingError(error, "会话清空失败，请稍后重试"));
      }
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="im-app">
      <MainContainer responsive className="im-container">
        <Sidebar position="left" scrollable className="im-sidebar">
          <div className="im-brand">
            <div className="im-brand-mark">✦</div>
            <div>
              <strong>Let Us Talk</strong>
              <span>私聊实验版</span>
            </div>
          </div>
          <div className="im-section-title">联系人</div>
          <ConversationList>
            {characters.map((character) => (
              <Conversation
                key={character.id}
                name={character.name}
                info={character.tagline}
                active={character.id === selected.id}
                data-character-id={character.id}
                onClick={() => setSelectedId(character.id)}
              >
                <Avatar name={character.name} src={avatarSource(character)} />
              </Conversation>
            ))}
          </ConversationList>
          <div className="im-sidebar-footer">
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
            typingIndicator={sending ? <TypingIndicator content={`${selected.name} 正在输入`} /> : undefined}
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
            {(sending || clearing) && (
              <div className="im-send-status" role="status" aria-live="polite">
                {sending ? `正在等待 ${selected.name} 回复…` : "正在清空当前会话…"}
              </div>
            )}
            {loadingConversation && <div className="im-loading-state">正在加载历史消息…</div>}
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
              <p>当前支持匿名用户、固定联系人和文字私聊；暂不提供长期记忆、群聊或 AI 主动消息。</p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
