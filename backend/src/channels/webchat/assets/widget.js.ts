/**
 * The embeddable loader, served as `GET /api/widget.js` (R4). Vanilla
 * ES2017, under 4 KB, no eval, no innerHTML: every node is built with DOM
 * APIs and only attributes/textContent are set.
 *
 * Snippet:
 *   <script src="https://<api-host>/api/widget.js" data-channel="<channelId>"
 *           data-lang="ar" data-position="end" data-color="#0f766e" async></script>
 *
 * - data-channel (required) the web chat channel id.
 * - data-lang (optional) en | ar; otherwise the hosted page decides
 *   (channel config, then browser language, then workspace language).
 * - data-position (optional) end | start (logical: end = right in LTR, left
 *   in RTL). Default end.
 * - data-color (optional) #rrggbb for the bubble; the page itself uses the
 *   channel's configured colour.
 * The API base is derived from the script's own src. The iframe is created
 * on the first click: /api/chat/<id>?embed=1&parent=<location.origin>&lang=.
 * The page asks to close via postMessage({type:"aram-widget:close"}), which is
 * accepted only from the iframe's window and the API origin.
 * `window.aramChat.open()/close()/toggle()` drive it from the host page.
 */
export const WIDGET_JS = String.raw`(function(){"use strict";
var s=document.currentScript;if(!s||window.aramChat)return;
var id=s.getAttribute("data-channel")||"";if(!/^[A-Za-z0-9_-]{1,64}$/.test(id))return;
var src=s.src||"",base=src.replace(/\/widget\.js(?:[?#].*)?$/,"");if(!src||base===src)return;
var api;try{api=new URL(src).origin}catch(e){return}
var lg=(s.getAttribute("data-lang")||"").toLowerCase(),lang=lg==="ar"||lg==="en"?lg:"";
var pos=s.getAttribute("data-position")==="start"?"start":"end";
var col=s.getAttribute("data-color")||"";if(!/^#[0-9a-fA-F]{6}$/.test(col))col="#111827";
var de=document.documentElement,rtl=lang?lang==="ar":(de.dir||getComputedStyle(de).direction)==="rtl";
var side=(pos==="end")!==rtl?"right":"left";
var ar=lang==="ar"||(!lang&&/^ar/i.test(de.lang||navigator.language||""));
var L=ar?{o:"افتح المحادثة",c:"أغلق المحادثة",t:"المحادثة"}:{o:"Open chat",c:"Close chat",t:"Chat"};
function css(el,o){for(var k in o)el.style.setProperty(k,o[k]);}
var NS="http://www.w3.org/2000/svg";
function icon(d){var v=document.createElementNS(NS,"svg");v.setAttribute("viewBox","0 0 24 24");v.setAttribute("width","26");v.setAttribute("height","26");v.setAttribute("aria-hidden","true");var p=document.createElementNS(NS,"path");p.setAttribute("d",d);p.setAttribute("fill","currentColor");v.appendChild(p);return v;}
var CHAT="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z",X="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z";
var btn=document.createElement("button");btn.type="button";btn.setAttribute("aria-label",L.o);btn.setAttribute("aria-expanded","false");
css(btn,{position:"fixed",bottom:"20px",width:"56px",height:"56px","border-radius":"50%",border:"0",background:col,color:"#fff",cursor:"pointer","box-shadow":"0 6px 20px rgba(0,0,0,.25)","z-index":"2147483000",display:"flex","align-items":"center","justify-content":"center",padding:"0"});
btn.style.setProperty(side,"20px");btn.appendChild(icon(CHAT));
var frame=null,open=false;
function make(){frame=document.createElement("iframe");
var q="embed=1&parent="+encodeURIComponent(location.origin)+(lang?"&lang="+lang:"");
frame.src=base+"/chat/"+encodeURIComponent(id)+"?"+q;frame.title=L.t;frame.setAttribute("referrerpolicy","origin");
css(frame,{position:"fixed",bottom:"88px",width:"min(380px, calc(100vw - 40px))",height:"min(600px, calc(100vh - 120px))",border:"0","border-radius":"14px","box-shadow":"0 12px 40px rgba(0,0,0,.25)","z-index":"2147483000",background:"#fff",display:"none"});
frame.style.setProperty(side,"20px");document.body.appendChild(frame);}
function set(v){if(v&&!frame)make();open=v;if(frame)frame.style.display=v?"block":"none";
btn.setAttribute("aria-expanded",v?"true":"false");btn.setAttribute("aria-label",v?L.c:L.o);btn.replaceChild(icon(v?X:CHAT),btn.firstChild);}
btn.addEventListener("click",function(){set(!open)});
window.addEventListener("message",function(e){if(!frame||e.source!==frame.contentWindow||e.origin!==api)return;var d=e.data;if(d&&d.type==="aram-widget:close")set(false)});
function mount(){document.body.appendChild(btn)}
if(document.body)mount();else document.addEventListener("DOMContentLoaded",mount);
window.aramChat={open:function(){set(true)},close:function(){set(false)},toggle:function(){set(!open)}};
})();
`;
