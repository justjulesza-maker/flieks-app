/**
 * festivals — the festivals, labs, markets and funds a Script Report may suggest.
 *
 * The report only ever names festivals from this list, so it never invents one.
 * No dates or deadlines here: they change every year, and the report tells the
 * filmmaker to check each festival's own site. Add or remove entries freely;
 * ids must stay unique and never be reused for a different festival.
 *
 * type:    festival | lab | market | fund
 * formats: short, feature, documentary, animation, series
 * stage:   script (a project in development), rough-cut, finished (a completed film)
 */
const FESTIVALS = [
  // ---- Africa ----
  { id: 'fespaco', name: 'FESPACO', where: 'Ouagadougou, Burkina Faso', type: 'festival', formats: ['short', 'feature', 'documentary', 'animation', 'series'], stages: ['finished'], focus: 'The continent’s biggest pan-African film festival, held every two years' },
  { id: 'jcc', name: 'Carthage Film Festival (JCC)', where: 'Tunis, Tunisia', type: 'festival', formats: ['short', 'feature', 'documentary'], stages: ['finished'], focus: 'African and Arab cinema' },
  { id: 'diff', name: 'Durban International Film Festival', where: 'Durban, South Africa', type: 'festival', formats: ['short', 'feature', 'documentary'], stages: ['finished'], focus: 'South Africa’s oldest film festival; strong on South African and African premieres' },
  { id: 'dfm', name: 'Durban FilmMart', where: 'Durban, South Africa', type: 'market', formats: ['feature', 'documentary', 'series'], stages: ['script'], focus: 'Co-production and finance market for African projects in development' },
  { id: 'jff', name: 'Joburg Film Festival', where: 'Johannesburg, South Africa', type: 'festival', formats: ['short', 'feature', 'documentary'], stages: ['finished'], focus: 'African and international films for Johannesburg audiences' },
  { id: 'encounters', name: 'Encounters South African International Documentary Festival', where: 'Cape Town and Johannesburg, South Africa', type: 'festival', formats: ['documentary'], stages: ['finished'], focus: 'Documentary' },
  { id: 'silwerskerm', name: 'Silwerskermfees', where: 'Cape Town, South Africa', type: 'festival', formats: ['short', 'feature'], stages: ['finished'], focus: 'Afrikaans-language film' },
  { id: 'afriff', name: 'Africa International Film Festival (AFRIFF)', where: 'Lagos, Nigeria', type: 'festival', formats: ['short', 'feature', 'documentary', 'animation'], stages: ['finished'], focus: 'West Africa’s leading festival; Nollywood and pan-African work' },
  { id: 'ziff', name: 'Zanzibar International Film Festival', where: 'Zanzibar, Tanzania', type: 'festival', formats: ['short', 'feature', 'documentary'], stages: ['finished'], focus: 'East African and Indian Ocean cinema' },
  { id: 'kalasha', name: 'Kalasha International Film & TV Market', where: 'Nairobi, Kenya', type: 'market', formats: ['feature', 'series', 'documentary'], stages: ['script', 'finished'], focus: 'East African film and TV market and awards' },
  { id: 'luxor', name: 'Luxor African Film Festival', where: 'Luxor, Egypt', type: 'festival', formats: ['short', 'feature', 'documentary'], stages: ['finished'], focus: 'African cinema' },
  { id: 'atlas', name: 'Atlas Workshops (Marrakech International Film Festival)', where: 'Marrakech, Morocco', type: 'lab', formats: ['feature', 'documentary'], stages: ['script', 'rough-cut'], focus: 'Development and post-production support for filmmakers from Africa and the Arab world' },
  // ---- African cinema abroad ----
  { id: 'paff', name: 'Pan African Film Festival', where: 'Los Angeles, USA', type: 'festival', formats: ['short', 'feature', 'documentary', 'series'], stages: ['finished'], focus: 'Films of the African diaspora; large US audience' },
  { id: 'nyaff', name: 'New York African Film Festival', where: 'New York, USA', type: 'festival', formats: ['short', 'feature', 'documentary'], stages: ['finished'], focus: 'African cinema' },
  { id: 'filmafrica', name: 'Film Africa', where: 'London, UK', type: 'festival', formats: ['short', 'feature', 'documentary'], stages: ['finished'], focus: 'African cinema for UK audiences' },
  { id: 'aim', name: 'Africa in Motion', where: 'Scotland, UK', type: 'festival', formats: ['short', 'feature', 'documentary'], stages: ['finished'], focus: 'African cinema; known for its short film competition' },
  { id: 'blackstar', name: 'BlackStar Film Festival', where: 'Philadelphia, USA', type: 'festival', formats: ['short', 'feature', 'documentary'], stages: ['finished'], focus: 'Films by Black, Brown and Indigenous artists' },
  { id: 'fabrique', name: 'La Fabrique Cinéma de l’Institut français (Cannes)', where: 'Cannes, France', type: 'lab', formats: ['feature'], stages: ['script'], focus: 'Brings first and second feature projects from Africa and the Global South to Cannes' },
  { id: 'finalcut', name: 'Final Cut in Venice', where: 'Venice, Italy', type: 'lab', formats: ['feature', 'documentary'], stages: ['rough-cut'], focus: 'Post-production support for films from Africa and the Arab world' },
  { id: 'hbf', name: 'Hubert Bals Fund (IFFR)', where: 'Rotterdam, Netherlands', type: 'fund', formats: ['feature', 'documentary'], stages: ['script', 'rough-cut'], focus: 'Development and production funding for filmmakers from Africa, Asia, Latin America and parts of Europe' },
  // ---- Major international ----
  { id: 'clermont', name: 'Clermont-Ferrand International Short Film Festival', where: 'Clermont-Ferrand, France', type: 'festival', formats: ['short', 'animation'], stages: ['finished'], focus: 'The world’s biggest short film festival and market' },
  { id: 'berlinale', name: 'Berlinale', where: 'Berlin, Germany', type: 'festival', formats: ['short', 'feature', 'documentary'], stages: ['finished'], focus: 'Major international festival; Generation section for films about young people' },
  { id: 'berlinale-talents', name: 'Berlinale Talents', where: 'Berlin, Germany', type: 'lab', formats: ['short', 'feature', 'documentary', 'series'], stages: ['script'], focus: 'Development programme for emerging filmmakers, including a script station' },
  { id: 'tiff', name: 'Toronto International Film Festival', where: 'Toronto, Canada', type: 'festival', formats: ['short', 'feature', 'documentary'], stages: ['finished'], focus: 'Major international launchpad with a strong market' },
  { id: 'sundance', name: 'Sundance Film Festival', where: 'USA', type: 'festival', formats: ['short', 'feature', 'documentary', 'series'], stages: ['finished'], focus: 'Independent film; strong world-cinema and short film sections' },
  { id: 'sundance-labs', name: 'Sundance Institute labs', where: 'USA', type: 'lab', formats: ['feature', 'documentary', 'series'], stages: ['script'], focus: 'Screenwriting and directing labs for independent storytellers' },
  { id: 'iffr', name: 'International Film Festival Rotterdam', where: 'Rotterdam, Netherlands', type: 'festival', formats: ['short', 'feature', 'documentary'], stages: ['finished'], focus: 'Independent and adventurous cinema' },
  { id: 'idfa', name: 'IDFA', where: 'Amsterdam, Netherlands', type: 'festival', formats: ['documentary'], stages: ['finished'], focus: 'The world’s largest documentary festival' },
  { id: 'hotdocs', name: 'Hot Docs', where: 'Toronto, Canada', type: 'festival', formats: ['documentary'], stages: ['finished'], focus: 'North America’s largest documentary festival' },
  { id: 'annecy', name: 'Annecy International Animation Film Festival', where: 'Annecy, France', type: 'festival', formats: ['animation'], stages: ['finished'], focus: 'The leading animation festival and market' },
  { id: 'palmsprings', name: 'Palm Springs International ShortFest', where: 'Palm Springs, USA', type: 'festival', formats: ['short'], stages: ['finished'], focus: 'Large short film festival and market' },
  { id: 'fantasia', name: 'Fantasia International Film Festival', where: 'Montreal, Canada', type: 'festival', formats: ['short', 'feature'], stages: ['finished'], focus: 'Genre film: horror, fantasy, action and thrillers' },
  { id: 'sxsw', name: 'SXSW Film & TV Festival', where: 'Austin, USA', type: 'festival', formats: ['short', 'feature', 'documentary', 'series'], stages: ['finished'], focus: 'Independent film and episodic work' },
  { id: 'tribeca', name: 'Tribeca Festival', where: 'New York, USA', type: 'festival', formats: ['short', 'feature', 'documentary', 'series'], stages: ['finished'], focus: 'Independent film, shorts and episodic work' }
];

const byId = Object.fromEntries(FESTIVALS.map(f => [f.id, f]));

/** The list as the model sees it: one line each. */
const forPrompt = () => FESTIVALS.map(f =>
  `${f.id} | ${f.name} | ${f.where} | ${f.type} | ${f.formats.join(', ')} | stage: ${f.stages.join(', ')} | ${f.focus}`).join('\n');

module.exports = { FESTIVALS, byId, forPrompt };
