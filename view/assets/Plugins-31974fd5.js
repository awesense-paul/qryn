import{h as p,d as s,F as x,f as g,j as u,g as m}from"./index-bc3ec90a.js";import{r as d}from"./react-432945ee.js";import{L as v}from"./PluginManagerFactory-e4944f23.js";import{r as b,i as S,S as P}from"./createSvgIcon-e78f4b10.js";import{j}from"./reactDnd-dc8b0776.js";import{u as N}from"./vendor-3db6068a.js";import"./reactSelect-db5d744f.js";import"./memoize-acaceb73.js";const _=e=>p("max-width:1440px;padding:10px;margin:10px;width:100%;display:-webkit-box;display:-webkit-flex;display:-ms-flexbox;display:flex;-webkit-flex:1;-ms-flex:1;flex:1;overflow-x:hidden;display:flex;flex:1;height:100%;overflow:hidden;max-width:1440px;align-self:center;.plugin-section{padding:4px;font-size:14px;color:",e.contrast,";}",""),k=e=>p("padding:10px;margin:4px;background:",e.shadow,";border:1px solid ",e.accentNeutral,";color:",e.contrast,";display:flex;align-items:flex-start;flex-direction:column;width:350px;border-radius:3px;height:fit-content;.image{display:flex;align-items:center;}.title{font-size:16px;padding:4px;align-self:flex-start;display:flex;align-items:center;width:100%;.plugin-name{flex:1;margin-left:10px;}.switch{display:flex;align-items:center;justify-self:end;}}.text{font-size:12px;padding:4px;line-height:1.5;}.icon{font-size:60px;opacity:0.25;}","");var f={},z=S;Object.defineProperty(f,"__esModule",{value:!0});var w=f.default=void 0,E=z(b()),C=j,M=(0,E.default)((0,C.jsx)("path",{d:"M10.5 4.5c.28 0 .5.22.5.5v2h6v6h2c.28 0 .5.22.5.5s-.22.5-.5.5h-2v6h-2.12c-.68-1.75-2.39-3-4.38-3s-3.7 1.25-4.38 3H4v-2.12c1.75-.68 3-2.39 3-4.38 0-1.99-1.24-3.7-2.99-4.38L4 7h6V5c0-.28.22-.5.5-.5m0-2C9.12 2.5 8 3.62 8 5H4c-1.1 0-1.99.9-1.99 2v3.8h.29c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-.3c0-1.49 1.21-2.7 2.7-2.7s2.7 1.21 2.7 2.7v.3H17c1.1 0 2-.9 2-2v-4c1.38 0 2.5-1.12 2.5-2.5S20.38 11 19 11V7c0-1.1-.9-2-2-2h-4c0-1.38-1.12-2.5-2.5-2.5z"}),"ExtensionOutlined");w=f.default=M;const O=e=>{const{name:n,active:t,section:a}=e,i=v(),[r,c]=d.useState(t),l=(o,y,h)=>{c(()=>!h),i.togglePlugin(o,y,!h)};return s(x,{children:s(P,{size:"small",checked:r,onChange:()=>l(a,n,r),inputProps:{"aria-label":"controlled"}})})},H=e=>{const{theme:n,name:t,description:a,section:i,active:r,visible:c}=e;return c?s(x,{children:u("div",{className:m(k(n)),children:[u("div",{className:"title",children:[s("div",{className:"image",children:s(w,{className:"icon"})}),u("div",{className:"plugin-name",children:[" ",t]}),s("div",{className:"switch",children:s(O,{active:r,name:t,section:i})})]}),s("div",{className:"text",children:a})]})}):s(x,{})},R=({components:e,section:n})=>{const t=N(l=>l.currentUser.role),a=d.useMemo(()=>e==null?void 0:e.filter(l=>l.roles.includes(t)),[t,e]),[i,r]=d.useState(a);d.useEffect(()=>{if(t&&e){let l=e==null?void 0:e.filter(o=>o.roles.includes(t));r(l)}},[t,e]);const c=g();return s("div",{children:(i==null?void 0:i.length)>0&&(i==null?void 0:i.map((l,o)=>s(H,{theme:c,name:l.name,active:l.active,visible:l.visible,section:n,description:l.description},o)))})};function U(){const e=g(),n=v(),[t]=d.useState(n.getAll()),a=d.useMemo(()=>{var i;return((i=Object.keys(t))==null?void 0:i.length)>0?Object.entries(t):[]},[t]);return s("div",{className:m(_(e)),children:(a==null?void 0:a.length)>0&&(a==null?void 0:a.map(([i,r],c)=>s("div",{style:{marginTop:"4px"},children:s(R,{components:r,section:i})},c)))})}export{U as default};
