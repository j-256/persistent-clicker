const params = new URLSearchParams(location.search);
const currentPage = Math.max(1, Number.parseInt(params.get("page") || "1", 10));
const pageNumber = document.querySelector("#page-number");
const reloadButton = document.querySelector("#reload-page");
const DEMO_VARIANTS = new Map([
  [
    "inventory",
    Object.freeze({
      title: "Inventory monitor demo",
      heading: "This button refreshes inventory.",
      description: "The monitor keeps running when the page changes.",
      buttonLabel: "Refresh inventory"
    })
  ],
  [
    "report",
    Object.freeze({
      title: "Status report demo",
      heading: "This button refreshes a report.",
      description: "The report keeps its schedule across every new URL.",
      buttonLabel: "Refresh report"
    })
  ]
]);

pageNumber.textContent = String(currentPage);
const demoVariant = DEMO_VARIANTS.get(params.get("demo"));

if (demoVariant) {
  document.title = demoVariant.title;
  document.querySelector("h1").textContent = demoVariant.heading;
  document.querySelector(".lede").textContent = demoVariant.description;
  document.querySelector(".button__label").textContent = demoVariant.buttonLabel;
}

reloadButton.addEventListener("click", () => {
  const nextUrl = new URL(location.href);
  nextUrl.searchParams.set("page", String(currentPage + 1));
  location.assign(nextUrl);
});
