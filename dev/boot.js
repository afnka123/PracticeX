// Loads panel.html's markup and scripts into this page, in the same order the extension does.
const src = await (await fetch("panel.html")).text();
const doc = new DOMParser().parseFromString(src, "text/html");
for (const link of doc.head.querySelectorAll("link")) document.head.append(link);
document.body.innerHTML = doc.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g, "");
const load = (path) =>
  new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = path;
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
await load("mathjax-config.js");
await load("vendor/mathjax/tex-svg-full.js");
await import("/extension/panel.js");
