// Info tab: useful links for the admin team
const LINKS = [
  { title: 'Rosary school, Hounslow: term dates', url: 'https://www.rosary.hounslow.sch.uk/Term-Dates/' },
];

export function tabInfo(view) {
  view.innerHTML = `
    <div class="card">
      <h2>Info</h2>
      <ul class="infolinks">
        ${LINKS.map(l => `<li><a href="${l.url}" target="_blank" rel="noopener">${l.title}</a> <span class="muted small">↗</span></li>`).join('')}
      </ul>
    </div>`;
}
