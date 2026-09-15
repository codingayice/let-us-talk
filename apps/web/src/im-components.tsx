import type { ReactNode } from "react";

export interface AvatarProps {
  name: string;
  src?: string | null;
  size?: "sm" | "md" | "lg";
  online?: boolean;
  status?: string;
}

export function Avatar({ name, src, size = "md", online }: AvatarProps) {
  return (
    <span className={`im-avatar im-avatar-${size}`}>
      <img src={src ?? undefined} alt={`${name}头像`} />
      {online !== undefined && <span className={`im-status-dot ${online ? "im-status-online" : "im-status-offline"}`} aria-label={online ? "在线" : "离线"} />}
    </span>
  );
}

export type NavItem = "messages" | "contacts" | "discover" | "me";

export function NavRail({ active, onChange, userImage }: { active: NavItem; onChange: (item: NavItem) => void; userImage?: string | null }) {
  const items: Array<{ id: NavItem; label: string; icon: string }> = [
    { id: "messages", label: "消息", icon: "▤" },
    { id: "contacts", label: "联系人", icon: "♧" },
    { id: "discover", label: "发现", icon: "⌕" },
    { id: "me", label: "我的", icon: "◉" },
  ];
  return (
    <aside className="im-nav" aria-label="主导航">
      <div className="im-nav-logo" aria-hidden="true">✦</div>
      <nav>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={active === item.id ? "im-nav-button im-nav-button-active" : "im-nav-button"}
            aria-label={item.label}
            aria-pressed={active === item.id}
            data-nav={item.id}
            onClick={() => onChange(item.id)}
          >
            <span aria-hidden="true">{item.icon}</span>
            <small>{item.label}</small>
          </button>
        ))}
      </nav>
      <button type="button" className="im-nav-user" onClick={() => onChange("me")} aria-label="我的账号">
        <Avatar name="我的账号" src={userImage} size="sm" />
      </button>
    </aside>
  );
}

export function SearchField({ placeholder }: { placeholder: string }) {
  return <label className="im-search"><span aria-hidden="true">⌕</span><input placeholder={placeholder} aria-label={placeholder} /><kbd>⌘ K</kbd></label>;
}

export function ConversationItem({ name, preview, time, avatar, active, unread, onClick, onContextMenu, onPointerDown, onPointerUp, onPointerCancel, onPointerLeave, conversationId }: {
  name: string;
  preview: string;
  time?: string;
  avatar?: string | null;
  active?: boolean;
  unread?: boolean;
  conversationId?: string;
  onClick: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  onPointerDown?: (event: React.PointerEvent) => void;
  onPointerUp?: () => void;
  onPointerCancel?: () => void;
  onPointerLeave?: () => void;
}) {
  return (
    <button
      type="button"
      className={`im-list-item im-conversation-item ${active ? "im-list-item-active" : ""}`}
      data-conversation-id={conversationId}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
    >
      <Avatar name={name} src={avatar} online />
      <span className="im-list-copy"><strong>{name}</strong><span>{preview}</span></span>
      <span className="im-list-meta">{time}</span>
      {unread && <span className="im-unread-badge" aria-label="未读消息">1</span>}
    </button>
  );
}

export function ContactItem({ id, name, tagline, avatar, active, onClick }: { id: string; name: string; tagline: string; avatar?: string | null; active?: boolean; onClick: () => void }) {
  return <button type="button" className={`im-list-item im-contact-item ${active ? "im-list-item-active" : ""}`} data-character-id={id} onClick={onClick}><Avatar name={name} src={avatar} online /><span className="im-list-copy"><strong>{name}</strong><span>{tagline}</span></span><span className="im-list-chevron">›</span></button>;
}

export function ChatHeader({ name, tagline, avatar, onBack, onProfile, onMenu }: { name: string; tagline: string; avatar?: string | null; onBack: () => void; onProfile: () => void; onMenu: () => void }) {
  return <header className="im-conversation-header"><button type="button" className="im-mobile-back" aria-label="返回列表" onClick={onBack}>‹</button><Avatar name={name} src={avatar} online size="md" /><div className="im-chat-heading"><strong>{name}</strong><span><i />在线 · {tagline}</span></div><div className="im-header-actions"><button type="button" className="im-icon-button" aria-label="语音通话（暂未开放）" disabled>⌕</button><button type="button" className="im-icon-button" aria-label="视频通话（暂未开放）" disabled>▣</button><button type="button" className="im-icon-button" aria-label="查看资料" onClick={onProfile}>⌁</button><button type="button" className="im-icon-button" aria-label="更多操作" onClick={onMenu}>⋯</button></div></header>;
}

export function MessageBubble({ content, role, sender, time, onCopy, copied }: { content: string; role: "user" | "assistant"; sender: string; time: string; onCopy: () => void; copied: boolean }) {
  return <div className={`im-message-row im-message-${role}`}><div className="im-message-content"><span className="im-message-sender">{sender}</span><p>{content}</p><time>{time}</time></div><button type="button" className="im-copy-message" aria-label="复制消息" onClick={onCopy}>{copied ? "已复制" : "复制"}</button></div>;
}

export function TypingIndicator({ content = "对方正在输入…" }: { content?: string }) {
  return <div className="im-typing" aria-label="对方正在输入"><span /><span /><span /><em>{content}</em></div>;
}

export function Composer({ value, onChange, onSend, disabled, placeholder }: { value: string; onChange: (value: string) => void; onSend: () => void; disabled?: boolean; placeholder: string }) {
  return <div className="im-composer"><div className="im-composer-toolbar"><button type="button" disabled aria-label="表情（暂未开放）">☺</button><button type="button" disabled aria-label="贴纸（暂未开放）">▣</button><button type="button" disabled aria-label="语音（暂未开放）">♩</button><button type="button" disabled aria-label="图片（暂未开放）">▧</button><span>Enter 发送 · Shift + Enter 换行</span></div><div className="im-composer-bar"><div className="im-editor" contentEditable={!disabled} role="textbox" aria-label={placeholder} data-placeholder={placeholder} suppressContentEditableWarning onInput={(event) => onChange(event.currentTarget.textContent ?? "")} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!disabled && value.trim()) onSend(); } }}>{value}</div><button type="button" className="cs-button--send im-send-button" aria-label="发送消息" disabled={disabled || !value.trim()} onClick={onSend}>↑</button></div></div>;
}

export function EmptyState({ title, detail, icon = "✦" }: { title: string; detail: string; icon?: string }) {
  return <div className="im-empty-state"><div className="im-empty-icon" aria-hidden="true">{icon}</div><strong>{title}</strong><span>{detail}</span></div>;
}

export function StatusNotice({ children, error = false, action }: { children: ReactNode; error?: boolean; action?: ReactNode }) {
  return <div className={`im-status-notice ${error ? "im-status-notice-error" : ""}`} role={error ? "alert" : "status"}><span>{children}</span>{action}</div>;
}

// Small compatibility primitives keep the application shell readable while the
// presentation layer remains owned by this package instead of ChatScope.
export function MainContainer({ children, className = "" }: { children: ReactNode; className?: string; responsive?: boolean }) { return <div className={`im-container ${className}`}>{children}</div>; }
export function Sidebar({ children, className = "" }: { children: ReactNode; className?: string; position?: string; scrollable?: boolean }) { return <aside className={`im-sidebar ${className}`}>{children}</aside>; }
export function ChatContainer({ children, className = "" }: { children: ReactNode; className?: string }) { return <section className={`im-chat-container ${className}`}>{children}</section>; }
export function ConversationList({ children }: { children: ReactNode }) { return <div className="im-conversation-list">{children}</div>; }
export function Conversation({ name, info, active, children, onClick, ...props }: { name: string; info: string; active?: boolean; children?: ReactNode; onClick?: () => void; [key: string]: unknown }) {
  return <button type="button" className={`im-list-item im-conversation-item ${active ? "im-list-item-active" : ""}`} onClick={onClick} {...props as React.ButtonHTMLAttributes<HTMLButtonElement>}><span className="im-avatar im-avatar-md">{children}</span><span className="im-list-copy"><strong>{name}</strong><span className="im-conversation-preview" data-preview={info} /></span></button>;
}
export function ConversationHeader({ children }: { children: ReactNode }) { return <header className="im-conversation-header cs-conversation-header">{children}</header>; }
export namespace ConversationHeader {
  export function Content({ userName, info }: { userName: string; info: string }) { return <div className="im-chat-heading"><strong>{userName}</strong><span><i />在线 · {info}</span></div>; }
  export function Actions({ children }: { children: ReactNode }) { return <div className="im-header-actions">{children}</div>; }
}
export function MessageList({ children, typingIndicator }: { children: ReactNode; typingIndicator?: ReactNode; [key: string]: unknown }) { return <div className="im-message-list cs-message-list"><div className="im-message-list-scroll cs-message-list__scroll-wrapper">{children}{typingIndicator}</div></div>; }
export function Message({ model }: { model: { message: string; sentTime: string; sender: string; direction: "incoming" | "outgoing"; position?: string } }) { return <div className={`im-message-content ${model.direction === "outgoing" ? "im-message-content-user" : ""}`}><span className="im-message-sender">{model.sender}</span><p>{model.message}</p><time>{model.sentTime}</time></div>; }
export function MessageInput({ value, onChange, onSend, placeholder, disabled, sendDisabled }: { value: string; onChange: (_html: string, text: string) => void; onSend: (_html: string, text: string) => void; placeholder: string; disabled?: boolean; sendDisabled?: boolean; [key: string]: unknown }) {
  return <div className="im-composer cs-message-input"><div className="im-composer-toolbar"><button type="button" disabled aria-label="表情（暂未开放）">☺</button><button type="button" disabled aria-label="贴纸（暂未开放）">▣</button><button type="button" disabled aria-label="语音（暂未开放）">♩</button><button type="button" disabled aria-label="图片（暂未开放）">▧</button><span>Enter 发送 · Shift + Enter 换行</span></div><div className="im-composer-bar"><textarea className="im-editor cs-message-input__content-editor" contentEditable={!disabled} role="textbox" aria-label={placeholder} placeholder={placeholder} value={value} disabled={disabled} onChange={(event) => onChange("", event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!sendDisabled) onSend("", value); } }} /><button type="button" className="cs-button--send im-send-button" aria-label="发送消息" disabled={sendDisabled} onClick={() => onSend("", value)}>↑</button></div></div>;
}
