"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { appPath, stripBasePath } from "@/lib/base-path";

/**
 * 登录 / 邀请码注册。
 *
 * 两者放在一个文件里，是因为它们共用同一套"提交中 / 出错 / 成功后跳哪儿"的状态机，
 * 拆成两个文件就要复制一遍。差别只在字段和调哪个接口。
 *
 * 文案原则：错误一律由服务端给（它知道是密码错、还是账号被停用），
 * 前端不自己猜，也不把"用户名不存在"和"密码错"分开显示 —— 那是给撞库的人当探针用的。
 */

type Mode = "login" | "signup";

const inputClass =
  "w-full rounded border border-neutral-800 bg-black px-3 py-2 text-[13px] text-neutral-100 outline-none transition-colors placeholder:text-neutral-700 focus:border-blue-500/60";
const labelClass = "mb-1.5 block font-mono text-[11px] text-neutral-500";
const buttonClass =
  "w-full rounded bg-white px-3 py-2 text-[13px] font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40";

async function postJson(url: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(appPath(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function messageOf(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const m = (data as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return fallback;
}

export function LoginPanel({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const { status, data } = await postJson("/api/auth/login", { username, password });
      if (status === 200) {
        // 用 replace 而不是 push：从登录页"后退"回登录页没有意义。
        // ?next= 可能是外部拼进来的、已经带了 /probe 前缀，交给路由前先剥掉（路由会自己加）。
        router.replace((nextPath && stripBasePath(nextPath)) || "/");
        router.refresh();
        return;
      }
      setError(messageOf(data, "登录失败，请稍后重试。"));
    } catch {
      setError("网络异常，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="w-full">
      <label className="mb-3 block">
        <span className={labelClass}>用户名</span>
        <input
          className={inputClass}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          required
        />
      </label>
      <label className="mb-3 block">
        <span className={labelClass}>密码</span>
        <input
          className={inputClass}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>

      {error && (
        <p className="mb-3 rounded border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-400">
          {error}
        </p>
      )}

      <button type="submit" className={buttonClass} disabled={busy || !username || !password}>
        {busy ? "登录中…" : "登录"}
      </button>

      <p className="mt-4 text-center font-mono text-[11px] text-neutral-600">
        有邀请码？{" "}
        <Link href="/signup" className="text-neutral-400 underline-offset-2 hover:text-white hover:underline">
          用它注册
        </Link>
      </p>
    </form>
  );
}

export function SignupPanel() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invite, setInvite] = useState<{ valid: boolean; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 邀请码边输边验：等 400ms 不敲了再问，避免每敲一个字符打一次接口。
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const trimmed = code.trim();
    if (trimmed.length < 8) {
      setInvite(null);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(appPath(`/api/auth/signup?code=${encodeURIComponent(trimmed)}`));
        const data = (await res.json()) as {
          valid?: boolean;
          reason?: string;
          role?: string;
          remainingUses?: number;
        };
        if (data.valid) {
          setInvite({
            valid: true,
            text: `可用 · ${data.role === "admin" ? "管理员" : "普通用户"} · 还剩 ${data.remainingUses ?? 0} 次`,
          });
        } else {
          const map: Record<string, string> = {
            not_found: "邀请码不存在",
            revoked: "邀请码已被撤销",
            exhausted: "邀请码已用完",
            expired: "邀请码已过期",
            auth_off: "本实例未开启鉴权",
          };
          setInvite({ valid: false, text: map[data.reason ?? ""] ?? "邀请码不可用" });
        }
      } catch {
        setInvite(null);
      }
    }, 400);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [code]);

  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || mismatch) return;
    setBusy(true);
    setError("");
    try {
      const { status, data } = await postJson("/api/auth/signup", { code, username, password });
      if (status === 201) {
        router.replace("/");
        router.refresh();
        return;
      }
      setError(messageOf(data, "注册失败，请稍后重试。"));
    } catch {
      setError("网络异常，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="w-full">
      <label className="mb-3 block">
        <span className={labelClass}>邀请码</span>
        <input
          className={inputClass + " font-mono"}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="管理员发给你的那一串"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          required
        />
        {invite && (
          <span
            className={
              "mt-1 block font-mono text-[10px] " + (invite.valid ? "text-emerald-500" : "text-red-400")
            }
          >
            {invite.text}
          </span>
        )}
      </label>
      <label className="mb-3 block">
        <span className={labelClass}>用户名</span>
        <input
          className={inputClass}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="3-32 位小写字母、数字、点、下划线"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      </label>
      <label className="mb-3 block">
        <span className={labelClass}>密码（至少 10 位）</span>
        <input
          className={inputClass}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
        />
      </label>
      <label className="mb-3 block">
        <span className={labelClass}>再输一次</span>
        <input
          className={inputClass}
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
        {mismatch && <span className="mt-1 block font-mono text-[10px] text-red-400">两次输入不一致</span>}
      </label>

      {error && (
        <p className="mb-3 rounded border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        className={buttonClass}
        disabled={busy || !code || !username || !password || mismatch}
      >
        {busy ? "注册中…" : "创建账号"}
      </button>

      <p className="mt-4 text-center font-mono text-[11px] text-neutral-600">
        已有账号？{" "}
        <Link href="/login" className="text-neutral-400 underline-offset-2 hover:text-white hover:underline">
          去登录
        </Link>
      </p>
    </form>
  );
}

export function ChangePasswordPanel() {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== next;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || mismatch) return;
    setBusy(true);
    setError("");
    try {
      const { status, data } = await postJson("/api/auth/password", {
        currentPassword: current,
        newPassword: next,
      });
      if (status === 200) {
        setDone(true);
        setCurrent("");
        setNext("");
        setConfirm("");
        router.refresh();
        return;
      }
      setError(messageOf(data, "修改失败，请稍后重试。"));
    } catch {
      setError("网络异常，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="w-full">
      <label className="mb-3 block">
        <span className={labelClass}>当前密码</span>
        <input
          className={inputClass}
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          autoFocus
          required
        />
      </label>
      <label className="mb-3 block">
        <span className={labelClass}>新密码（至少 10 位）</span>
        <input
          className={inputClass}
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          required
        />
      </label>
      <label className="mb-3 block">
        <span className={labelClass}>再输一次</span>
        <input
          className={inputClass}
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
        {mismatch && <span className="mt-1 block font-mono text-[10px] text-red-400">两次输入不一致</span>}
      </label>

      {error && (
        <p className="mb-3 rounded border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-400">
          {error}
        </p>
      )}
      {done && (
        <p className="mb-3 rounded border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2 text-[12px] text-emerald-400">
          密码已更新，其他设备上的登录已失效。
        </p>
      )}

      <button
        type="submit"
        className={buttonClass}
        disabled={busy || !current || !next || mismatch}
      >
        {busy ? "保存中…" : "保存新密码"}
      </button>

      <p className="mt-4 text-center font-mono text-[11px] text-neutral-600">
        改完其他设备会掉线，只有当前这台保持登录。
      </p>
    </form>
  );
}

