// Loads panel.html's markup and scripts into this page, in the same order the extension does.
// Everything is cache-busted so a reload always shows the files as they are on disk.
const V = Date.now();
const src = await (await fetch("panel.html", { cache: "reload" })).text();
const doc = new DOMParser().parseFromString(src, "text/html");
for (const link of doc.head.querySelectorAll("link")) {
  // In a parsed document href is unresolved, so work on the attribute, not the property.
  const href = link.getAttribute("href");
  if (href && !href.startsWith("http")) link.setAttribute("href", `${href}?v=${V}`);
  document.head.append(link);
}
document.body.innerHTML = doc.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g, "");
const load = (path) =>
  new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = path;
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
await load(`mathjax-config.js?v=${V}`);
await load("vendor/mathjax/tex-svg-full.js");
await import(`/extension/panel.js?v=${V}`);
