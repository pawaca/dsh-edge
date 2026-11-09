/** Self-contained Vietnamese public chat. The server never receives local saved drafts/history
 * except the bounded context that the user explicitly submits to DeepSeek.
 */
export const publicChatHtml = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>BilaBot · Trợ lý AI tiếng Việt</title>
<style>
:root{color-scheme:dark;font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;background:#090e1e;color:#e9efff}
*{box-sizing:border-box}body{margin:0}button,textarea{font:inherit}button{cursor:pointer}
.shell{max-width:1120px;margin:auto;min-height:100vh;display:grid;grid-template-columns:250px minmax(0,1fr);gap:0;background:#0d1427;border-inline:1px solid #26334d}
aside{background:#0c1222;border-right:1px solid #24314c;padding:22px 14px;display:flex;flex-direction:column;gap:16px}
.brand{font-size:23px;font-weight:780;color:#d4e6ff}.brand b{color:#7bbaff}
.sub,.privacy,.foot{font-size:12px;color:#95a6c3}
button{background:#1c2a46;color:#e6edff;border:1px solid #334467;border-radius:11px;padding:10px 13px}
button:hover{background:#2c3b5b}button:focus-visible,textarea:focus-visible{outline:2px solid #75adfa;outline-offset:2px}
.primary{background:#2264d0;border-color:#3678e2;color:#fff}.danger{color:#ffc1c1}
.history{display:grid;gap:7px;overflow:auto;max-height:50vh}.history button{text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.history .selected{border-color:#6298ec;background:#1f355c}
main{min-width:0;display:flex;flex-direction:column;height:100vh}
header{padding:17px 25px;border-bottom:1px solid #26334d;display:flex;justify-content:space-between;align-items:center;gap:12px}
header strong{font-size:17px}.online{font-size:12px;color:#80c7ab}
#messages{flex:1;overflow:auto;padding:28px clamp(15px,5vw,65px);display:flex;flex-direction:column;gap:18px}
.bubble{max-width:85%;padding:15px 18px;border:1px solid #2a3a56;border-radius:18px;white-space:pre-wrap;overflow-wrap:anywhere}
.bubble.user{align-self:flex-end;background:#194988;border-color:#2b69ad}.bubble.assistant{align-self:flex-start;background:#172139}
.welcome{text-align:center;margin:auto;color:#a9bedb}.welcome h1{color:#edf4ff}
.composer{padding:14px clamp(15px,5vw,65px) 24px;border-top:1px solid #26334d}
textarea{width:100%;min-height:85px;max-height:220px;resize:vertical;background:#101c33;color:#f2f6ff;border:1px solid #395074;border-radius:14px;padding:13px}
.actions{display:flex;gap:10px;justify-content:space-between;align-items:center;margin-top:9px}
#send{min-width:100px}.tools{display:flex;flex-wrap:wrap;gap:8px}.tools button{font-size:12px;padding:7px 9px}
@media(max-width:760px){.shell{display:block}aside{padding:9px 14px;border-right:0;border-bottom:1px solid #26334d;gap:8px}
aside .history,aside .privacy{display:none}.brand{font-size:18px}main{height:calc(100dvh - 98px)}
header{padding:10px 14px}#messages{padding:17px 12px}.bubble{max-width:95%}.composer{padding:12px}}
</style></head><body><div class="shell">
<aside><div><div class="brand">✦ <b>Bila</b>Bot</div><div class="sub">Thử nghiệm AI công khai · Tiếng Việt</div></div>
<button id="new" class="primary">＋ Cuộc trò chuyện mới</button>
<div class="sub">Lịch sử trên thiết bị này</div><nav id="history" class="history" aria-label="Lịch sử trò chuyện"></nav>
<div class="privacy">🔒 Không đăng nhập. Nhật ký chỉ lưu trong trình duyệt. Nội dung gửi để trả lời sẽ được xử lý bởi DeepSeek; không nhập dữ liệu nhạy cảm.</div>
</aside><main><header><div><strong>BilaBot · Trò chuyện AI</strong><div id="status" class="online">Đang kiểm tra cấu hình…</div></div><span class="sub" id="model"></span></header>
<section id="messages" aria-live="polite"><div class="welcome"><h1>Xin chào! 👋</h1><p>Hãy gửi câu hỏi để bắt đầu trò chuyện bằng tiếng Việt.</p><p class="sub">Dùng chung mô hình AI do chủ website cấu hình.</p></div></section>
<div class="composer"><form id="chat-form"><label class="sub" for="prompt">Tin nhắn của bạn</label>
<textarea id="prompt" maxlength="6000" placeholder="Nhập câu hỏi của bạn… (Enter để gửi, Shift+Enter để xuống dòng)" required></textarea>
<div class="actions"><div class="tools"><button type="button" id="export">Xuất JSON</button><button type="button" id="clear" class="danger">Xóa lịch sử</button></div>
<button class="primary" id="send" type="submit">Gửi ↗</button></div></form><div class="foot">Dữ liệu trong trình duyệt có thể bị xóa khi dọn bộ nhớ hoặc ở chế độ riêng tư.</div></div>
</main></div><script src="/public/app.js" defer></script></body></html>`

export const publicChatJavascript = `'use strict';
(() => {
  const KEY='bilabot-public-chats-v1';
  const $=id=>document.getElementById(id);
  const isMsg=m=>m && (m.role==='user'||m.role==='assistant') && typeof m.content==='string';
  let chats=[], current='', busy=false;
  try {
    const saved=JSON.parse(localStorage.getItem(KEY)||'[]');
    if(Array.isArray(saved)) chats=saved.filter(c=>c&&typeof c.id==='string'&&Array.isArray(c.messages))
      .slice(-40).map(c=>({id:c.id,title:String(c.title||'Hội thoại').slice(0,70),
      messages:c.messages.filter(isMsg).slice(-100)}));
  } catch { chats=[]; }
  function save(){
    try { localStorage.setItem(KEY,JSON.stringify(chats.slice(-40))); }
    catch { $('status').textContent='Bộ nhớ trình duyệt đã đầy. Hãy xuất hoặc xóa lịch sử.'; }
  }
  function active(){return chats.find(c=>c.id===current)}
  function newChat(){const c={id:crypto.randomUUID(),title:'Cuộc trò chuyện mới',messages:[]};
    chats.push(c);current=c.id;save();render()}
  function render(){
    $('history').replaceChildren();
    chats.slice().reverse().forEach(c=>{const b=document.createElement('button');
      b.type='button'; b.className=c.id===current?'selected':'';
      b.textContent=c.title;b.onclick=()=>{if(!busy){current=c.id;render()}};$('history').append(b)});
    $('messages').replaceChildren();
    const msgs=active()?.messages||[];
    if(!msgs.length){const intro=document.createElement('div');intro.className='welcome';
      intro.textContent='Xin chào! Hãy nhập câu hỏi để bắt đầu.';$('messages').append(intro)}
    for(const m of msgs){const e=document.createElement('div');e.className='bubble '+m.role;
      e.textContent=m.content;$('messages').append(e)}
    $('messages').scrollTop=$('messages').scrollHeight;
  }
  function lock(value){busy=value;$('send').disabled=value;$('prompt').disabled=value;
    $('new').disabled=value; $('clear').disabled=value;$('send').textContent=value?'Đang trả lời…':'Gửi ↗'}
  $('new').onclick=()=>{if(!busy)newChat()};
  $('clear').onclick=()=>{if(!busy&&confirm('Xóa tất cả lịch sử trong trình duyệt này?')){
    chats=[];localStorage.removeItem(KEY);newChat()}};
  $('export').onclick=()=>{const blob=new Blob([JSON.stringify(chats,null,2)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);
    a.download='bilabot-lich-su.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};
  $('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){
    e.preventDefault();$('chat-form').requestSubmit()}});
  $('chat-form').addEventListener('submit',async e=>{
    e.preventDefault();if(busy)return;
    const text=$('prompt').value.trim();if(!text)return;
    const c=active();c.messages.push({role:'user',content:text});
    if(c.messages.length===1)c.title=text.slice(0,52);
    $('prompt').value='';save();render();lock(true);
    try{
      const history=c.messages.slice(-19);
      const response=await fetch('/api/public/chat',{method:'POST',
        headers:{'content-type':'application/json'},credentials:'omit',
        body:JSON.stringify({messages:history})});
      const data=await response.json();
      if(!response.ok||!data.ok)throw new Error(data.error||'Không thể kết nối.');
      c.messages.push({role:'assistant',content:String(data.answer)});
      save();render();
    }catch(err){
      $('status').textContent=err instanceof Error?err.message:'Yêu cầu thất bại.';
    }finally{lock(false);$('prompt').focus()}
  });
  if(chats.length){current=chats[chats.length-1].id;render()}else newChat();
  fetch('/api/public/config',{credentials:'omit'}).then(r=>r.json()).then(d=>{
    $('model').textContent=d.model||''; $('status').textContent=d.ready?'Sẵn sàng · Không cần đăng nhập':'Chưa cấu hình API key';
  }).catch(()=>{$('status').textContent='Không thể kiểm tra dịch vụ'});
})();`;
