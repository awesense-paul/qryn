import{r as y}from"./react-432945ee.js";import{G as x}from"./index-bc3ec90a.js";const A=s=>t=>{t({type:"SET_PLUGINS",plugins:s})},b={Main:{parent:"",children:["Status Bar","Panel"]},"Status Bar":{parent:"Main",children:[""]},Panel:{parent:"Main",children:["Queries","Data Views"]},Queries:{parent:"Panel",children:["Stats","Data Views"]},Stats:{parent:"Queries",children:[""]},"Data Views":{parent:"Panel",children:["Data View Header","View"]},"Query Item":{parent:"Queries",children:[]}};function I(){function s(){try{return JSON.parse(localStorage.getItem("plugins")||"{}")}catch{return{}}}function t(i,o){var l;let a=s();a[i]||(a[i]=[]),(l=a[i])!=null&&l.some(e=>e.name===o.name)||(a[i].push(o),localStorage.setItem("plugins",JSON.stringify(a)))}function u(i){let o=s();return o[i]?o[i]:[]}function m(i,o){var l,e;let a=s();if(a[i]&&Array.isArray(a[i])&&((l=a[i])!=null&&l.some(r=>r.name===o))){let r=(e=a[i])==null?void 0:e.filter(n=>n.name!==o);a[i]=r,localStorage.setItem("plugins",JSON.stringify(a))}}function c(i,o,a){var r;const l=s(),e=(r=l[i])==null?void 0:r.findIndex(n=>(n==null?void 0:n.name)===o);if(e>=0){const n={...l,[i]:l[i].map((g,f)=>f===e?{...g,active:a}:g)};localStorage.setItem("plugins",JSON.stringify(n))}}function P(i,o,a){var r;const l=s(),e=(r=l[i])==null?void 0:r.findIndex(n=>(n==null?void 0:n.name)===o);if(e>=0){const n={...l,[i]:l[i].map((g,f)=>f===e?{...g,visible:a}:g)};localStorage.setItem("plugins",JSON.stringify(n))}}return{getAll:s,getPluginsFromLocation:u,setPlugin:t,removePlugin:m,togglePlugin:c,togglePluginVisibility:P}}function v(){const s=I(),[t]=y.useState(s.getAll());return y.useMemo(()=>{var m;return((m=Object.keys(t))==null?void 0:m.length)>0?Object.entries(t):[]},[t])}function w(s){const t=v(),u=y.useMemo(()=>{if(t!=null&&t.some(c=>c[0]===s)){let c=t==null?void 0:t.filter(([P])=>P===s)[0][1];return c==null?void 0:c.filter(P=>P.active&&P.visible)}return[]},[t]),m=y.useMemo(()=>(u==null?void 0:u.length)>0,u);return{activeTabs:u,isActiveTabs:m}}function O(s){const t={},u=I();let m=u.getAll();function c(e){var r;t[e.section]||(t[e.section]=[]),t[e.section].push(e),x.dispatch(A(t)),(r=m[e.section])!=null&&r.some(n=>n.name===e.name)||u.setPlugin(e.section,e)}function P(e){for(let r in s)r!=="Main"&&c(e)}function i(e){var f,d;let r=u.getPluginsFromLocation(e);const n=(f=t==null?void 0:t[e])==null?void 0:f.filter((h,S)=>{var p;return((p=t[e])==null?void 0:p.findIndex(M=>M.name===h.name))===S});let g=[];if((n==null?void 0:n.length)>0)for(let h of r){let S=(d=n==null?void 0:n.find)==null?void 0:d.call(n,p=>p.name===h.name);h.active&&g.push(S)}return g||[]}function o(e,r){var f;const n=(f=t==null?void 0:t[e])==null?void 0:f.filter((d,h)=>{var S;return((S=t[e])==null?void 0:S.findIndex(p=>p.name===d.name))===h});return(n==null?void 0:n.find(d=>(d==null?void 0:d.name)===r))||{}}function a(e,r,n){u.togglePlugin(e,r,n)}function l(){const e=[];for(let r in s)r!=="Main"&&e.push(...i(r));return e}return{registerPlugin:c,registerPluginGlobally:P,getAllPlugins:l,getPlugins:i,getPlugin:o,togglePlugin:a}}const L=O(b);function J(s){s.forEach(t=>{t.visible&&L.registerPlugin(t)})}export{I as L,L as P,J as i,w as u};
