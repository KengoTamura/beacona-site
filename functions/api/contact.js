// /api/contact — お問い合わせフォームのサーバー処理（Cloudflare Pages Functions）
// POST受信 → バリデーション → 通知メール(info@beacona.jp) ＋ 送信者への自動返信 → JSONレスポンス。
// 公開エンドポイント（認証なし）。スパム対策＝honeypot ＋ 簡易レート制限(KV・任意)。
// メール送信は Resend もしくは MailChannels（環境変数で選択。キーは Secret 設定／コードに出さない）。
//
// レスポンス形（contact ページの UI と整合）:
//   成功           : 200 { ok:true }
//   入力エラー     : 400 { ok:false, error, fields? }
//   レート超過     : 429 { ok:false, error }
//   送信失敗(上流) : 502 { ok:false, error }
//   サーバーエラー : 500 { ok:false, error }
//
// _headers / CSP の変更は不要（同一オリジンPOST・fetch は default-src 'self' の範囲内）。

const TO_DEFAULT = "info@beacona.jp";                 // 受信先（変更不要）
const FROM_DEFAULT = "noreply@send.beacona.jp";        // Resend 検証済みドメイン
const BRAND = "Beacona";

// ---- レスポンスヘルパ（webapp の functions/api/_lib/db.js と同形）----
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
const ok = () => json({ ok: true });
const bad = (error, status = 400, extra = {}) => json({ ok: false, error, ...extra }, status);

// 単一行フィールド用：制御文字（改行・タブ含む）を除去し、連続空白を畳んで長さ制限。
// ＝メールの Subject / Reply-To へ載せる値のヘッダインジェクション対策（多層防御）。
function clean(v, max = 200) {
  return String(v ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
// 複数行フィールド用（ご相談内容）：改行(\n)は残し、その他の制御文字のみ除去。
function cleanMultiline(v, max = 5000) {
  return String(v ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const looksLikePhone = (v) =>
  /^[0-9+\-() 　]{9,20}$/.test(v.replace(/[‐－―ー]/g, "-"));

// ---- ボディ解析（JSON / urlencoded / multipart 対応）----
async function readBody(request) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    const o = await request.json().catch(() => ({}));
    return o && typeof o === "object" ? o : {};
  }
  const fd = await request.formData();
  const o = {};
  for (const key of new Set([...fd.keys()])) {
    const all = fd.getAll(key);
    o[key] = all.length > 1 ? all.map(String) : String(all[0]);
  }
  return o;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await readBody(request);

    // 1) honeypot：人間には不可視の company_url に値があれば bot → 成功を装って黙って破棄
    if (clean(body.company_url, 200)) return ok();

    // 2) 入力取得＋整形
    const company = clean(body.company, 100);
    const name = clean(body.name, 100);
    const contact = clean(body.contact, 200);
    const industry = clean(body.industry, 100);
    const message = cleanMultiline(body.message, 5000);
    let services = body.service ?? body.services ?? [];
    if (!Array.isArray(services)) services = services ? [services] : [];
    services = services.map((s) => clean(s, 60)).filter(Boolean).slice(0, 8);

    // 3) 必須チェック（4項目）
    const missing = [];
    if (!company) missing.push("company");
    if (!name) missing.push("name");
    if (!contact) missing.push("contact");
    if (!message) missing.push("message");
    if (missing.length) return bad("必須項目が未入力です。", 400, { fields: missing });

    const contactIsEmail = isEmail(contact);
    if (!contactIsEmail && !looksLikePhone(contact)) {
      return bad("ご連絡先は、メールアドレスまたは電話番号の形式でご入力ください。", 400, {
        fields: ["contact"],
      });
    }

    // 4) 簡易レート制限（KV: env.RATE_LIMIT があれば適用。無ければスキップ）
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (await rateLimited(env, ip)) {
      return bad("送信が集中しています。しばらく時間をおいて再度お試しください。", 429);
    }

    // 5) 通知メール本文（info@beacona.jp 宛）
    const to = clean(env.CONTACT_TO || TO_DEFAULT, 200);
    const from = clean(env.CONTACT_FROM || FROM_DEFAULT, 200);
    const recvAt = new Date().toISOString();
    const lines = [
      `屋号・店名 : ${company}`,
      `お名前     : ${name}`,
      `ご連絡先   : ${contact}`,
      industry ? `業種       : ${industry}` : null,
      services.length ? `興味       : ${services.join(" / ")}` : null,
      "",
      "ご相談内容 :",
      message,
      "",
      `― 受信: ${recvAt} ／ IP: ${ip}`,
    ]
      .filter((l) => l !== null)
      .join("\n");

    const notify = {
      to: [{ email: to, name: BRAND }],
      from: { email: from, name: `${BRAND} お問い合わせフォーム` },
      replyTo: contactIsEmail ? { email: contact, name } : undefined,
      subject: `【お問い合わせ】${company}（${name}）`,
      text: `Beacona お問い合わせフォームに新しい送信がありました。\n\n${lines}\n`,
    };

    // 6) 通知メール送信。失敗時は 502（フォールバックとして直接メール導線を案内）
    const sent = await sendEmail(env, notify);
    if (!sent.ok) {
      return bad(
        "送信処理に失敗しました。お手数ですが info@beacona.jp まで直接ご連絡ください。",
        502
      );
    }

    // 7) 自動返信（連絡先がメールのときのみ／失敗しても全体は成功扱い）
    if (contactIsEmail) {
      await sendEmail(env, {
        to: [{ email: contact, name }],
        from: { email: from, name: BRAND },
        replyTo: { email: to, name: BRAND },
        subject: "【Beacona】お問い合わせを受け付けました",
        text: autoReplyText({ name, company, message }),
      }).catch(() => {});
    }

    return ok();
  } catch (e) {
    console.error("contact error", e);
    return bad("サーバーエラーが発生しました。時間をおいて再度お試しください。", 500);
  }
}

function autoReplyText({ name, company, message }) {
  return [
    `${company} ${name} 様`,
    "",
    "この度は Beacona へお問い合わせいただき、ありがとうございます。",
    "下記の内容で受け付けました。担当より数日以内にご連絡いたします。",
    "（しつこい営業はいたしません／オンライン相談も可）",
    "",
    "――― お問い合わせ内容 ―――",
    message,
    "――――――――――――――",
    "",
    "※本メールは送信専用の自動返信です。ご返信は確認が遅れる場合があります。",
    "　お急ぎの場合は info@beacona.jp ／ Instagram @beaconajp までどうぞ。",
    "",
    "Beacona｜千葉県浦安市猫実",
    "https://beacona.jp ／ info@beacona.jp",
  ].join("\n");
}

// ---- 簡易レート制限（KV 任意）。同一IP 5回/10分で制限。KV未設定なら無効。----
async function rateLimited(env, ip) {
  const kv = env.RATE_LIMIT;
  if (!kv || ip === "unknown") return false;
  const key = `contact:${ip}`;
  const cur = parseInt((await kv.get(key)) || "0", 10);
  if (cur >= 5) return true;
  await kv.put(key, String(cur + 1), { expirationTtl: 600 });
  return false;
}

// ---- メール送信抽象：RESEND_API_KEY 優先、無ければ MailChannels ----
async function sendEmail(env, msg) {
  try {
    if (env.RESEND_API_KEY) return await sendViaResend(env, msg);
    if (env.MAILCHANNELS_API_KEY) return await sendViaMailChannels(env, msg);
    console.error("no email provider configured (RESEND_API_KEY / MAILCHANNELS_API_KEY)");
    return { ok: false, error: "no-provider" };
  } catch (e) {
    console.error("sendEmail failed", e);
    return { ok: false, error: e.message };
  }
}

async function sendViaResend(env, msg) {
  const payload = {
    from: `${msg.from.name} <${msg.from.email}>`,
    to: msg.to.map((t) => t.email),
    subject: msg.subject,
    text: msg.text,
  };
  if (msg.replyTo) payload.reply_to = msg.replyTo.email;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error("resend send failed", res.status, await res.text());
    return { ok: false };
  }
  return { ok: true };
}

async function sendViaMailChannels(env, msg) {
  const personalization = { to: msg.to };
  // DKIM は任意だが到達率向上のため強く推奨（Secret で秘密鍵を設定）。
  if (env.DKIM_DOMAIN && env.DKIM_SELECTOR && env.DKIM_PRIVATE_KEY) {
    personalization.dkim_domain = env.DKIM_DOMAIN;
    personalization.dkim_selector = env.DKIM_SELECTOR;
    personalization.dkim_private_key = env.DKIM_PRIVATE_KEY;
  }
  const payload = {
    personalizations: [personalization],
    from: msg.from,
    subject: msg.subject,
    content: [{ type: "text/plain", value: msg.text }],
  };
  if (msg.replyTo) payload.reply_to = msg.replyTo;
  const res = await fetch("https://api.mailchannels.net/tx/v1/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.MAILCHANNELS_API_KEY,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error("mailchannels send failed", res.status, await res.text());
    return { ok: false };
  }
  return { ok: true };
}
