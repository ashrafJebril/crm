/**
 * The hosted chat page client, inlined by `GET /api/chat/:channelId` under
 * the page's CSP nonce. Vanilla ES2017, same-origin with the API (so no
 * CORS), no eval, no innerHTML: message text is set with textContent only.
 *
 * Boot data comes from <body data-*> (rendered and escaped by hosted-page.ts):
 * channel, lang, embed ("1"/"0"), parent (the verified embedding origin or
 * ""), api (the API path prefix, "/api").
 *
 * - fetches GET {api}/widget/:id/config?parent= for greeting/colour/askName;
 * - keeps {visitorId, visitorToken} in localStorage["tkw:<id>"] (wrapped in
 *   try/catch, with an in-memory fallback for blocked storage);
 * - sends with POST {api}/widget/:id/messages and renders the reply;
 * - live replies: socket.io namespace /widget (client script served by the
 *   API at {api}/socket.io/socket.io.js), auth {channelId, visitorId,
 *   visitorToken}. Polling GET .../messages?after= every 4 s is the fallback
 *   when the script cannot load or the socket cannot connect.
 */
export const CHAT_PAGE_JS = String.raw`(function(){"use strict";
var b=document.body,D=b.dataset,ch=D.channel||"",lang=D.lang==="ar"?"ar":"en",embed=D.embed==="1",parent=D.parent||"",API=D.api||"/api";
var T={en:{fail:"Couldn't send. Please try again.",slow:"Too many messages. Please wait a moment.",gone:"This chat is not available.",long:"Message is too long."},
ar:{fail:"تعذّر الإرسال. حاول مرة أخرى.",slow:"رسائل كثيرة. انتظر قليلًا.",gone:"هذه المحادثة غير متاحة.",long:"الرسالة طويلة جدًا."}}[lang];
function $(i){return document.getElementById(i)}
var log=$("wc-log"),form=$("wc-form"),input=$("wc-input"),nameEl=$("wc-name"),status=$("wc-status"),sendBtn=$("wc-send"),closeBtn=$("wc-close");
var KEY="tkw:"+ch,mem=null,seen={},last="",sock=null,timer=null,greeting="";
function load(){try{var v=JSON.parse(localStorage.getItem(KEY)||"null");if(v&&typeof v.visitorId==="string"&&typeof v.visitorToken==="string")return v}catch(e){}return mem}
function save(v){mem=v;try{localStorage.setItem(KEY,JSON.stringify(v))}catch(e){}}
function qs(o){var p=[];for(var k in o){if(o[k]!==undefined&&o[k]!==null&&o[k]!=="")p.push(encodeURIComponent(k)+"="+encodeURIComponent(o[k]))}return p.length?"?"+p.join("&"):""}
function url(path,q){return API+"/widget/"+encodeURIComponent(ch)+path+qs(q||{})}
function say(t){status.textContent=t||""}
function add(m){if(!m||typeof m.id!=="string"||seen[m.id])return;seen[m.id]=1;
var row=document.createElement("div");row.className="wc-msg "+(m.from==="visitor"?"wc-me":"wc-them");
var p=document.createElement("p");p.setAttribute("dir","auto");p.textContent=String(m.body==null?"":m.body);row.appendChild(p);
log.appendChild(row);if(typeof m.at==="string"&&m.at>last)last=m.at;log.scrollTop=log.scrollHeight}
async function getJson(u,opt){var r=await fetch(u,Object.assign({credentials:"omit",cache:"no-store"},opt||{}));var j=null;try{j=await r.json()}catch(e){}return{ok:r.ok,status:r.status,body:j}}
function err(r){if(r.status===429)return T.slow;if(r.status===404)return T.gone;if(r.body&&r.body.message==="widget.invalid_message")return T.long;return T.fail}
async function history(after){var v=load();if(!v)return;
var r=await getJson(url("/messages",{visitorId:v.visitorId,visitorToken:v.visitorToken,after:after||undefined,parent:parent}));
if(r.ok&&r.body&&Array.isArray(r.body.items))r.body.items.forEach(add);
else if(r.status===403&&!after){try{localStorage.removeItem(KEY)}catch(e){}mem=null}}
function poll(){if(timer)return;timer=setInterval(function(){history(last).catch(function(){})},4000)}
function unpoll(){if(timer){clearInterval(timer);timer=null}}
function connect(){var v=load();if(!v||sock)return;
if(typeof window.io!=="function"){var sc=document.createElement("script");sc.src=API+"/socket.io/socket.io.js";
sc.onload=function(){if(typeof window.io==="function")connect();else poll()};sc.onerror=poll;document.head.appendChild(sc);return}
try{sock=window.io("/widget",{path:API+"/socket.io",auth:{channelId:ch,visitorId:v.visitorId,visitorToken:v.visitorToken}});
sock.on("widget.message",add);
sock.on("connect",function(){unpoll();history(last).catch(function(){})});
sock.on("connect_error",poll);sock.on("disconnect",poll)}catch(e){poll()}}
async function boot(){var r=await getJson(url("/config",{parent:parent}));
if(!r.ok){say(err(r));input.disabled=true;sendBtn.disabled=true;return}
var c=r.body||{};
if(typeof c.color==="string"&&/^#[0-9a-fA-F]{6}$/.test(c.color))document.documentElement.style.setProperty("--wc",c.color);
greeting=(lang==="ar"?c.greetingAr||c.greeting:c.greeting||c.greetingAr)||"";
if(greeting)add({id:"greeting",from:"agent",body:greeting});
if(c.askName&&!load())nameEl.hidden=false;
if(load()){await history();connect()}}
form.addEventListener("submit",async function(e){e.preventDefault();var text=input.value.trim();if(!text)return;
if(text.length>2000){say(T.long);return}
var v=load(),payload={body:text,parent:parent||undefined};
if(v){payload.visitorId=v.visitorId;payload.visitorToken=v.visitorToken}
else if(!nameEl.hidden&&nameEl.value.trim())payload.name=nameEl.value.trim().slice(0,80);
sendBtn.disabled=true;say("");
try{var r=await getJson(url("/messages"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
if(!r.ok){say(err(r));if(r.status===403&&v){try{localStorage.removeItem(KEY)}catch(x){}mem=null}return}
var first=!v;save({visitorId:r.body.visitorId,visitorToken:r.body.visitorToken});
input.value="";nameEl.hidden=true;add(r.body.message);if(first)connect()}
catch(x){say(T.fail)}finally{sendBtn.disabled=false;input.focus()}});
input.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();form.requestSubmit?form.requestSubmit():sendBtn.click()}});
if(embed&&parent&&window.parent!==window){closeBtn.hidden=false;closeBtn.addEventListener("click",function(){window.parent.postMessage({type:"tk-widget:close"},parent)})}
boot().catch(function(){say(T.fail)});
})();
`;
