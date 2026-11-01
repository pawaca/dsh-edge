/**
 * Edge owner authentication in the upstream desktop Welcome presentation.
 * Layout, typography and palette adapted from DeepSeek Harness welcome.css
 * (MIT, copyright 2026 DeepSeek). Only deployment-key authentication is exposed.
 */
export function ownerPage(request: Request, authenticated: boolean, upgradeCommand: string, error?: string): string {
  const zh = /^zh\b/iu.test(request.headers.get('accept-language') ?? '')
  const keyStep = error !== undefined || new URL(request.url).searchParams.get('step') === 'key'
  const m = zh ? {
    welcome: '欢迎使用', description: '组装无限可能，共探智能上限',
    login: '登录', title: '输入访问密钥', subtitle: '使用此部署的访问密钥登录',
    label: '访问密钥', back: '返回', invalid: '访问密钥不正确，请重试。',
    recovery: '忘记访问密钥？', recoveryText: '运行以下命令，选择更新并重置访问密钥。对话和文件将保留。',
    unlocked: '此浏览器已登录', continue: '进入 DeepSeek Harness', logout: '退出登录',
  } : {
    welcome: 'Welcome to', description: 'Build infinite possibilities, together',
    login: 'Sign in', title: 'Enter your access key', subtitle: 'Sign in with the access key for this deployment',
    label: 'Owner access key', back: 'Back', invalid: 'The access key is not valid.',
    recovery: 'Lost your access key?', recoveryText: 'Run the command below and choose Update and reset the access key. Conversations and files are kept.',
    unlocked: 'This browser is unlocked', continue: 'Continue to DeepSeek Harness', logout: 'Sign out',
  }
  const content = authenticated
    ? `<section class="key-heading"><h1>${m.unlocked}</h1></section>
       <div class="actions"><a class="primary" href="/">${m.continue}</a>
       <form method="post" action="/api/auth/logout"><button class="secondary" type="submit">${m.logout}</button></form></div>`
    : keyStep
      ? `<form id="key-form" class="key-form" method="post" action="/api/auth/login">
          <header class="key-heading"><h1>${m.title}</h1><p id="key-description">${m.subtitle}</p></header>
          <div class="key-field"><label class="visually-hidden" for="access-key">${m.label}</label>
            <input id="access-key" name="accessKey" type="password" autocomplete="current-password"
              placeholder="${m.label}" aria-describedby="key-description${error === undefined ? '' : ' key-error'}"
              ${error === undefined ? '' : 'aria-invalid="true"'} required autofocus>
            ${error === undefined ? '' : `<p id="key-error" class="key-error" role="alert">${m.invalid}</p>`}
          </div>
          <details class="recovery"><summary>${m.recovery}</summary><p>${m.recoveryText}</p><code>${upgradeCommand}</code></details>
        </form>
        <div class="actions"><button class="primary" type="submit" form="key-form">${m.login}</button><a class="back" href="/login">${m.back}</a></div>`
      : `<section class="tagline"><h1><span>${m.welcome} </span><em>DeepSeek Harness</em></h1><p>${m.description}</p></section>
         <div class="actions"><a class="primary" href="/login?step=key">${m.login}</a></div>`
  return `<!doctype html>
<html lang="${zh ? 'zh-CN' : 'en'}"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${m.login} · DSH Edge</title><style>${styles}</style>
</head><body><main class="welcome" aria-label="DSH Edge">
  <img class="brand" src="/owner-login/welcome-brand.svg" alt="DeepSeek Harness" width="472" height="40">
  ${content}
</main></body></html>`
}

const styles = `
@font-face { font-family: Montserrat; font-weight: 300; font-display: swap; src: url('/owner-login/montserrat-light.woff2') format('woff2'); }
@font-face { font-family: Montserrat; font-weight: 500; font-display: swap; src: url('/owner-login/montserrat-medium.woff2') format('woff2'); }
:root {
  color-scheme: light dark; --primary: #0f1115; --secondary: #61666b; --caption: #adb2b8;
  --background: #fff; --inverted: #fff; --hover: #43454a; --border: #00000029;
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --primary: #f9fafb; --secondary: #cfd3d6; --caption: #81858c;
    --background: #1b1c1e; --inverted: #353638; --hover: #ebeef2; --border: #ffffff33; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--background); color: var(--primary); font-family: Montserrat, var(--font); font-weight: 300; -webkit-font-smoothing: antialiased; }
.welcome { min-height: 100vh; min-height: 100svh; display: grid; grid-template-rows: 40px minmax(320px, 1fr) auto;
  justify-items: center; align-items: center; gap: 24px; padding: 74px 48px 80px; }
.brand { display: block; width: min(472px, 100%); height: 40px; }
.tagline { color: var(--secondary); font-size: 24px; line-height: 40px; text-align: center; }
.tagline h1, .tagline p { margin: 0; font: inherit; }
.tagline em { color: var(--primary); font-size: 26px; font-style: normal; font-weight: 500; }
:lang(en) .tagline em { font-size: inherit; }
.key-form { width: min(440px, 100%); display: flex; flex-direction: column; align-items: center; gap: 40px; }
.key-heading { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; }
.key-heading h1 { margin: 0; font-size: 20px; font-weight: 400; line-height: 32px; letter-spacing: .01em; }
.key-heading p { margin: 0; color: var(--secondary); font-size: 16px; line-height: 22px; letter-spacing: .02em; }
.key-field { width: 100%; }
input { display: block; width: 100%; height: 48px; padding: 7px 14px; border: 1px solid var(--border);
  border-radius: 12px; background: transparent; color: var(--primary); font: inherit; font-size: 16px; line-height: 24px; }
input:focus { outline: none; border-color: var(--primary); }
input::placeholder { color: var(--caption); opacity: 1; }
.key-error { margin: 8px 0 0; font-family: var(--font); font-size: 14px; line-height: 22px; }
.actions { display: flex; flex-direction: column; align-items: stretch; gap: 16px; width: min(240px, 100%); }
.actions form { margin: 0; }
.actions button, .actions a { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 44px;
  padding: 8px 16px; border: 1px solid transparent; border-radius: 10px; font-family: var(--font); font-size: 14px;
  font-weight: 500; line-height: 22px; text-align: center; text-decoration: none; cursor: pointer; }
.primary { background: var(--primary); color: var(--inverted); }
.primary:hover { background: var(--hover); }
.actions .secondary { border-color: var(--border); background: transparent; color: var(--primary); }
.actions .back { background: transparent; color: var(--secondary); font-family: inherit; font-weight: 300; }
a:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
.recovery { width: 100%; text-align: center; color: var(--secondary); font-family: var(--font); font-size: 13px; line-height: 20px; }
.recovery summary { cursor: pointer; }
.recovery p { margin: 12px 0; }
.recovery code { overflow-wrap: anywhere; user-select: all; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 600px) {
  .welcome { padding: max(48px, env(safe-area-inset-top)) 24px max(32px, env(safe-area-inset-bottom)); grid-template-rows: 40px minmax(260px, 1fr) auto; }
  .tagline { font-size: 18px; line-height: 32px; }
  .tagline em { font-size: 20px; }
  .key-form { gap: 28px; }
}
@media (max-height: 540px) {
  .welcome { padding-top: 24px; padding-bottom: 24px; grid-template-rows: 40px minmax(200px, 1fr) auto; gap: 20px; }
}
`
