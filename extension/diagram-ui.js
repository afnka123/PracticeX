// The strip under a figure: zoom buttons on the left, and a line that is the hint until the student
// clicks something worth reading, then says what they clicked.

export function controlBar({ onZoom, onReset, hint }) {
  const bar = document.createElement("div");
  bar.className = "diagram-bar";
  const zoom = document.createElement("div");
  zoom.className = "zoom";
  const button = (text, label, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "zoom-btn";
    b.textContent = text;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", fn);
    zoom.append(b);
  };
  button("−", "Zoom out", () => onZoom(1 / 1.4));
  button("+", "Zoom in", () => onZoom(1.4));
  button("⟲", "Reset the view", onReset);

  const line = document.createElement("p");
  line.className = "diagram-hint mono";
  line.textContent = hint;
  const say = (text) => {
    line.textContent = text || hint;
    line.classList.toggle("reading", Boolean(text));
  };
  bar.append(zoom, line);
  return { bar, say };
}
