import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

const API_BASE = "https://pokeapi.co/api/v2";
const TEAM_SIZE = 6;
const PICKER_LIMIT = 18;
const STORAGE_KEY = "pokemon-team-builder-save-data";
const SESSION_STORAGE_KEY = "pokemon-team-builder-session-draft";

type GenerationOption = {
  id: number;
  label: string;
};

type PokemonIndexEntry = {
  id: number;
  name: string;
};

type TeamMember = {
  id: number;
  name: string;
  displayName: string;
  menuSprite: string;
  teamRender: string;
  types: string[];
  item: string;
};

type SavedTeam = {
  id: string;
  name: string;
  generationId: number;
  members: TeamMember[];
  updatedAt: string;
};

type SessionDraft = {
  generationId: number;
  teamName: string;
  currentTeamId: string | null;
  members: TeamMember[];
};

type PokeApiGenerationResponse = {
  pokemon_species: Array<{
    name: string;
    url: string;
  }>;
};

type PokeApiPokemonResponse = {
  id: number;
  name: string;
  sprites: {
    front_default: string | null;
    other: {
      home: {
        front_default: string | null;
      };
      "official-artwork": {
        front_default: string | null;
      };
    };
  };
  types: Array<{
    type: {
      name: string;
    };
  }>;
};

type PokeApiItemsResponse = {
  results: Array<{
    name: string;
  }>;
};

const generations: GenerationOption[] = [
  { id: 1, label: "Generacion I - Kanto" },
  { id: 2, label: "Generacion II - Johto" },
  { id: 3, label: "Generacion III - Hoenn" },
  { id: 4, label: "Generacion IV - Sinnoh" },
  { id: 5, label: "Generacion V - Unova" },
  { id: 6, label: "Generacion VI - Kalos" },
  { id: 7, label: "Generacion VII - Alola" },
  { id: 8, label: "Generacion VIII - Galar / Hisui" },
  { id: 9, label: "Generacion IX - Paldea" }
];

export function App() {
  const initialDraft = useMemo(() => readSessionDraft(), []);
  const [selectedGeneration, setSelectedGeneration] = useState(initialDraft?.generationId ?? 1);
  const [pokemonIndex, setPokemonIndex] = useState<PokemonIndexEntry[]>([]);
  const [itemNames, setItemNames] = useState<string[]>([]);
  const [team, setTeam] = useState<TeamMember[]>(initialDraft?.members.map(normalizeSavedMember) ?? []);
  const [filterText, setFilterText] = useState("");
  const deferredFilterText = useDeferredValue(filterText);
  const [pickerPage, setPickerPage] = useState(0);
  const [teamName, setTeamName] = useState(initialDraft?.teamName ?? "");
  const [currentTeamId, setCurrentTeamId] = useState<string | null>(initialDraft?.currentTeamId ?? null);
  const [savedTeams, setSavedTeams] = useState<SavedTeam[]>(() => readSavedTeams());
  const [helperText, setHelperText] = useState("Cargando Pokemon...");
  const [status, setStatus] = useState<{ text: string; tone: "" | "error" | "success" }>({
    text: "",
    tone: ""
  });
  const [isBusy, setIsBusy] = useState(false);
  const pendingLoadedTeamRef = useRef<SavedTeam | null>(null);
  const hasLoadedItemsRef = useRef(false);

  const pokemonMap = useMemo(
    () => new Map(pokemonIndex.map((entry) => [entry.name, entry])),
    [pokemonIndex]
  );

  useEffect(() => {
    void loadItems();
  }, []);

  useEffect(() => {
    persistSessionDraft({
      generationId: selectedGeneration,
      teamName,
      currentTeamId,
      members: team
    });
  }, [currentTeamId, selectedGeneration, team, teamName]);

  useEffect(() => {
    let cancelled = false;

    async function loadGenerationPokemon() {
      setIsBusy(true);
      setHelperText("Cargando Pokemon de la generacion...");

      try {
        const entries = await fetchGenerationEntries(selectedGeneration);
        if (cancelled) {
          return;
        }

        setPokemonIndex(entries);
        setFilterText("");
        setPickerPage(0);
        setHelperText(`${entries.length} Pokemon disponibles hasta ${getGenerationLabel(selectedGeneration)}.`);

        const pendingTeam = pendingLoadedTeamRef.current;
        if (pendingTeam && pendingTeam.generationId === selectedGeneration) {
          setTeam(pendingTeam.members.map(normalizeSavedMember));
          setTeamName(pendingTeam.name);
          setCurrentTeamId(pendingTeam.id);
          pendingLoadedTeamRef.current = null;
          setStatus({
            text: `Equipo "${pendingTeam.name}" cargado.`,
            tone: "success"
          });
        } else if (!pendingTeam && !initialDraft) {
          setTeam([]);
        }
      } catch (error) {
        if (!cancelled) {
          setStatus({
            text: error instanceof Error ? error.message : "No se pudo cargar la generacion desde PokeAPI.",
            tone: "error"
          });
        }
      } finally {
        if (!cancelled) {
          setIsBusy(false);
        }
      }
    }

    void loadGenerationPokemon();

    return () => {
      cancelled = true;
    };
  }, [initialDraft, selectedGeneration]);

  const filteredPokemon = useMemo(() => {
    const normalizedFilter = deferredFilterText.trim().toLowerCase();
    if (!normalizedFilter) {
      return pokemonIndex;
    }

    return pokemonIndex.filter((entry) => entry.name.includes(normalizedFilter));
  }, [deferredFilterText, pokemonIndex]);

  const totalPages = Math.max(1, Math.ceil(filteredPokemon.length / PICKER_LIMIT));
  const safePickerPage = Math.min(pickerPage, totalPages - 1);

  useEffect(() => {
    if (pickerPage !== safePickerPage) {
      setPickerPage(safePickerPage);
    }
  }, [pickerPage, safePickerPage]);

  const visiblePokemon = useMemo(() => {
    const start = safePickerPage * PICKER_LIMIT;
    return filteredPokemon.slice(start, start + PICKER_LIMIT);
  }, [filteredPokemon, safePickerPage]);

  const saveSummary = savedTeams.length
    ? `${savedTeams.length} equipo${savedTeams.length === 1 ? "" : "s"} guardado${savedTeams.length === 1 ? "" : "s"}.`
    : "Todavia no guardaste equipos.";

  async function loadItems() {
    if (hasLoadedItemsRef.current) {
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/item?limit=2500`);
      if (!response.ok) {
        throw new Error("No se pudieron cargar los objetos desde PokeAPI.");
      }

      const data = (await response.json()) as PokeApiItemsResponse;
      setItemNames(data.results.map((item) => item.name));
      hasLoadedItemsRef.current = true;
      setStatus({ text: "Listo para armar tu equipo.", tone: "success" });
    } catch (error) {
      setStatus({
        text: error instanceof Error ? error.message : "No se pudieron cargar los objetos desde PokeAPI.",
        tone: "error"
      });
    }
  }

  async function handleAddPokemon(rawName: string) {
    const normalizedName = rawName.trim().toLowerCase();

    if (!normalizedName) {
      setStatus({ text: "Escribe o selecciona un Pokemon antes de agregarlo.", tone: "error" });
      return;
    }

    if (!pokemonMap.has(normalizedName)) {
      setStatus({
        text: "Ese Pokemon no entra en el rango de generaciones seleccionado.",
        tone: "error"
      });
      return;
    }

    if (team.length >= TEAM_SIZE) {
      setStatus({ text: "Tu equipo ya tiene 6 Pokemon.", tone: "error" });
      return;
    }

    if (team.some((member) => member.name === normalizedName)) {
      setStatus({ text: "Ese Pokemon ya esta en el equipo.", tone: "error" });
      return;
    }

    setIsBusy(true);
    setHelperText("Agregando Pokemon al equipo...");

    try {
      const pokemon = await fetchPokemon(normalizedName);
      setTeam((currentTeam) => [...currentTeam, createTeamMemberFromPokemon(pokemon)]);
      setFilterText("");
      setPickerPage(0);
      setStatus({
        text: `${normalizeDisplayName(pokemon.name)} se agrego al equipo.`,
        tone: "success"
      });
    } catch (error) {
      setStatus({
        text: error instanceof Error ? error.message : "No se pudo cargar ese Pokemon.",
        tone: "error"
      });
    } finally {
      setIsBusy(false);
      setHelperText(`${pokemonIndex.length} Pokemon disponibles hasta ${getGenerationLabel(selectedGeneration)}.`);
    }
  }

  function handleGenerationChange(nextGeneration: number) {
    pendingLoadedTeamRef.current = null;
    setSelectedGeneration(nextGeneration);
    setCurrentTeamId(null);
    setTeamName("");
    setTeam([]);
    setStatus({
      text: `Pokemon hasta ${getGenerationLabel(nextGeneration)} cargados.`,
      tone: "success"
    });
  }

  function handleClearTeam() {
    setTeam([]);
    setStatus({ text: "Equipo vaciado.", tone: "success" });
  }

  function handleItemChange(slot: number, value: string) {
    setTeam((currentTeam) =>
      currentTeam.map((member, index) =>
        index === slot ? { ...member, item: normalizeDisplayName(value) } : member
      )
    );
  }

  function handleRemovePokemon(slot: number) {
    setTeam((currentTeam) => currentTeam.filter((_, index) => index !== slot));
    setStatus({ text: "Pokemon removido del equipo.", tone: "success" });
  }

  function handleNewTeam() {
    pendingLoadedTeamRef.current = null;
    setCurrentTeamId(null);
    setTeamName("");
    setTeam([]);
    setStatus({ text: "Nuevo equipo listo para editar.", tone: "success" });
  }

  function handleSaveTeam() {
    const trimmedName = teamName.trim();

    if (!trimmedName) {
      setStatus({ text: "Ponle un nombre al equipo antes de guardarlo.", tone: "error" });
      return;
    }

    if (!team.length) {
      setStatus({ text: "Agrega al menos un Pokemon antes de guardar.", tone: "error" });
      return;
    }

    const payload: SavedTeam = {
      id: currentTeamId ?? makeTeamId(),
      name: trimmedName,
      generationId: selectedGeneration,
      members: team,
      updatedAt: new Date().toISOString()
    };

    setSavedTeams((currentTeams) => {
      const nextTeams = [...currentTeams];
      const existingIndex = nextTeams.findIndex((entry) => entry.id === payload.id);

      if (existingIndex >= 0) {
        nextTeams[existingIndex] = payload;
      } else {
        nextTeams.unshift(payload);
      }

      persistSavedTeams(nextTeams);
      return nextTeams;
    });

    setCurrentTeamId(payload.id);
    setTeamName(payload.name);
    setStatus({ text: `Equipo "${payload.name}" guardado.`, tone: "success" });
  }

  function handleDeleteTeam(teamId: string) {
    const teamToDelete = savedTeams.find((entry) => entry.id === teamId);
    const nextTeams = savedTeams.filter((entry) => entry.id !== teamId);
    setSavedTeams(nextTeams);
    persistSavedTeams(nextTeams);

    if (currentTeamId === teamId) {
      setCurrentTeamId(null);
    }

    setStatus({
      text: teamToDelete ? `Equipo "${teamToDelete.name}" borrado.` : "Equipo borrado.",
      tone: "success"
    });
  }

  function handleLoadTeam(teamId: string) {
    const savedTeam = savedTeams.find((entry) => entry.id === teamId);
    if (!savedTeam) {
      setStatus({ text: "No encontre ese equipo guardado.", tone: "error" });
      return;
    }

    pendingLoadedTeamRef.current = savedTeam;
    setSelectedGeneration(savedTeam.generationId);

    if (savedTeam.generationId === selectedGeneration) {
      setTeam(savedTeam.members.map(normalizeSavedMember));
      setTeamName(savedTeam.name);
      setCurrentTeamId(savedTeam.id);
      pendingLoadedTeamRef.current = null;
      setStatus({ text: `Equipo "${savedTeam.name}" cargado.`, tone: "success" });
    }
  }

  return (
    <>
      <div className="backdrop backdrop-one" />
      <div className="backdrop backdrop-two" />

      <main className="app-shell">
        <section className="hero">
          <h1>Crea tu equipo Pokemon por generacion</h1>
          <div className="hero-badges">
            <span className="hero-badge alt">1ra a 9na generacion</span>
            <span className="hero-badge">React + TypeScript</span>
          </div>
          <p className="hero-copy">
            Elige el tope de generacion, arma varios equipos, guardalos por nombre y dales
            vida con renders animados estilo Pokemon.
          </p>
        </section>

        <section className="controls panel">
          <div className="field-group">
            <label htmlFor="generation">Generacion</label>
            <select
              id="generation"
              value={selectedGeneration}
              onChange={(event) => handleGenerationChange(Number(event.target.value))}
              disabled={isBusy}
            >
              {generations.map((generation) => (
                <option key={generation.id} value={generation.id}>
                  {generation.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field-group grow">
            <label htmlFor="pokemon-search">Buscar Pokemon de la generacion</label>
            <div className="search-row">
              <input
                id="pokemon-search"
                type="search"
                placeholder="Ej: charizard, garchomp, tinkaton"
                value={filterText}
                onChange={(event) => {
                  setFilterText(event.target.value);
                  setPickerPage(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleAddPokemon(filterText);
                  }
                }}
              />
              <button type="button" disabled={isBusy} onClick={() => void handleAddPokemon(filterText)}>
                Agregar al equipo
              </button>
            </div>

            <p className="helper-text">{helperText}</p>

            <div className="picker-toolbar">
              <button
                className="picker-nav"
                type="button"
                aria-label="Pagina anterior"
                disabled={safePickerPage === 0}
                onClick={() => setPickerPage((page) => Math.max(0, page - 1))}
              >
                {"<"}
              </button>
              <p className="picker-page">Pagina {safePickerPage + 1} de {totalPages}</p>
              <button
                className="picker-nav"
                type="button"
                aria-label="Pagina siguiente"
                disabled={safePickerPage >= totalPages - 1}
                onClick={() => setPickerPage((page) => Math.min(totalPages - 1, page + 1))}
              >
                {">"}
              </button>
            </div>

            <div className="pokemon-picker" aria-live="polite">
              {visiblePokemon.length ? (
                visiblePokemon.map((entry) => {
                  const alreadySelected = team.some((member) => member.name === entry.name);
                  return (
                    <button
                      key={entry.name}
                      className="picker-option"
                      type="button"
                      disabled={alreadySelected}
                      onClick={() => void handleAddPokemon(entry.name)}
                    >
                      <img src={getMiniSpriteUrl(entry.id)} alt={normalizeDisplayName(entry.name)} />
                      <span>{normalizeDisplayName(entry.name)}</span>
                      <small>#{String(entry.id).padStart(3, "0")}</small>
                    </button>
                  );
                })
              ) : (
                <div className="picker-empty">No hay resultados para esa busqueda.</div>
              )}
            </div>
          </div>
        </section>

        <section className="panel team-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">Tu equipo</p>
              <h2>Hasta 6 Pokemon</h2>
            </div>
            <button className="ghost-button" type="button" onClick={handleClearTeam}>
              Vaciar equipo
            </button>
          </div>

          <div className="team-manager">
            <div className="field-group grow">
              <label htmlFor="team-name">Nombre del equipo</label>
              <input
                id="team-name"
                type="text"
                placeholder="Ej: Hoenn ofensivo"
                value={teamName}
                onChange={(event) => setTeamName(event.target.value)}
              />
            </div>
            <button type="button" onClick={handleSaveTeam}>
              Guardar equipo
            </button>
            <button className="ghost-button" type="button" onClick={handleNewTeam}>
              Nuevo equipo
            </button>
          </div>

          <div className="saved-panel">
            <div className="saved-panel-header">
              <p className="section-kicker">Equipos guardados</p>
              <p className="saved-summary">{saveSummary}</p>
            </div>

            <div className="saved-teams">
              {savedTeams.length ? (
                savedTeams.map((savedTeam) => (
                  <article
                    key={savedTeam.id}
                    className={`saved-card ${savedTeam.id === currentTeamId ? "active" : ""}`}
                  >
                    <div className="saved-card-top">
                      <div>
                        <h3>{savedTeam.name}</h3>
                        <p>{getGenerationLabel(savedTeam.generationId)}</p>
                      </div>
                      <span>{savedTeam.members.length}/6</span>
                    </div>

                    <div className="saved-preview">
                      {savedTeam.members.length ? (
                        savedTeam.members.map((member) => (
                          <img
                            key={`${savedTeam.id}-${member.name}`}
                            src={member.menuSprite || getMiniSpriteUrl(member.id)}
                            alt={member.displayName}
                          />
                        ))
                      ) : (
                        <span className="saved-empty-preview">Sin Pokemon</span>
                      )}
                    </div>

                    <div className="saved-actions">
                      <button type="button" onClick={() => handleLoadTeam(savedTeam.id)}>
                        Cargar
                      </button>
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => handleDeleteTeam(savedTeam.id)}
                      >
                        Borrar
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <p className="saved-empty">Guarda un equipo para verlo aca.</p>
              )}
            </div>
          </div>

          <div className={`status ${status.tone}`}>{status.text}</div>

          <div className="team-grid">
            {Array.from({ length: TEAM_SIZE }, (_, slot) => {
              const member = team[slot];
              if (!member) {
                return (
                  <article key={slot} className="team-card empty">
                    <div className="slot-number">{slot + 1}</div>
                    <div className="empty-copy">
                      <span>Espacio libre</span>
                      <p>Agrega un Pokemon para completar este lugar.</p>
                    </div>
                  </article>
                );
              }

              return (
                <article key={member.name} className="team-card">
                  <div className="pokemon-name-row">
                    <div className="slot-number">{slot + 1}</div>
                    <button
                      className="card-actions"
                      type="button"
                      onClick={() => handleRemovePokemon(slot)}
                    >
                      Quitar
                    </button>
                  </div>

                  <div className="pokemon-header">
                    <div
                      className="render-stage"
                      style={
                        {
                          "--float-delay": `${slot * 0.18}s`,
                          "--float-rotation": slot % 2 === 0 ? "-2deg" : "2deg"
                        } as React.CSSProperties
                      }
                    >
                      <img className="team-render" src={member.teamRender} alt={member.displayName} />
                    </div>
                    <div>
                      <h3 className="pokemon-name">{member.displayName}</h3>
                      <p className="pokemon-meta">#{String(member.id).padStart(3, "0")}</p>
                    </div>
                  </div>

                  <div className="type-list">
                    {member.types.map((type) => (
                      <span key={`${member.name}-${type}`} className="type-pill">
                        {type}
                      </span>
                    ))}
                  </div>

                  <div className="item-block">
                    <label htmlFor={`item-${slot}`}>Objeto</label>
                    <input
                      id={`item-${slot}`}
                      list="item-options"
                      type="text"
                      placeholder="Ej: leftovers, choice-band"
                      value={member.item}
                      onChange={(event) => handleItemChange(slot, event.target.value)}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </main>

      <datalist id="item-options">
        {itemNames.map((itemName) => (
          <option key={itemName} value={itemName} />
        ))}
      </datalist>
    </>
  );
}

async function fetchGenerationEntries(generationId: number): Promise<PokemonIndexEntry[]> {
  const responses = await Promise.all(
    generations
      .filter((generation) => generation.id <= generationId)
      .map((generation) => fetch(`${API_BASE}/generation/${generation.id}`))
  );

  if (responses.some((response) => !response.ok)) {
    throw new Error("No se pudo cargar la generacion desde PokeAPI.");
  }

  const datasets = (await Promise.all(
    responses.map((response) => response.json())
  )) as PokeApiGenerationResponse[];

  const entriesByName = new Map<string, PokemonIndexEntry>();

  datasets.forEach((data) => {
    data.pokemon_species.forEach((species) => {
      const id = Number(species.url.split("/").filter(Boolean).pop());
      if (!entriesByName.has(species.name)) {
        entriesByName.set(species.name, { id, name: species.name });
      }
    });
  });

  return [...entriesByName.values()].sort((left, right) => left.id - right.id);
}

async function fetchPokemon(name: string): Promise<PokeApiPokemonResponse> {
  const response = await fetch(`${API_BASE}/pokemon/${name}`);
  if (!response.ok) {
    throw new Error("No se pudo cargar ese Pokemon.");
  }

  return (await response.json()) as PokeApiPokemonResponse;
}

function createTeamMemberFromPokemon(pokemon: PokeApiPokemonResponse): TeamMember {
  return {
    id: pokemon.id,
    name: pokemon.name,
    displayName: normalizeDisplayName(pokemon.name),
    menuSprite: getMiniSpriteUrl(pokemon.id),
    teamRender:
      pokemon.sprites.other.home.front_default ??
      pokemon.sprites.other["official-artwork"].front_default ??
      pokemon.sprites.front_default ??
      getMiniSpriteUrl(pokemon.id),
    types: pokemon.types.map((entry) => normalizeDisplayName(entry.type.name)),
    item: ""
  };
}

function normalizeSavedMember(member: TeamMember): TeamMember {
  return {
    ...member,
    displayName: member.displayName || normalizeDisplayName(member.name),
    menuSprite: member.menuSprite || getMiniSpriteUrl(member.id),
    teamRender: member.teamRender || member.menuSprite || getMiniSpriteUrl(member.id)
  };
}

function normalizeDisplayName(value: string): string {
  return value
    .split("-")
    .map((fragment) => fragment.charAt(0).toUpperCase() + fragment.slice(1))
    .join(" ");
}

function getGenerationLabel(id: number): string {
  return generations.find((generation) => generation.id === id)?.label ?? `Generacion ${id}`;
}

function getMiniSpriteUrl(id: number): string {
  return `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${id}.png`;
}

function makeTeamId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `team-${Date.now()}`;
}

function readSavedTeams(): SavedTeam[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SavedTeam[]) : [];
  } catch {
    return [];
  }
}

function persistSavedTeams(savedTeams: SavedTeam[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(savedTeams));
}

function readSessionDraft(): SessionDraft | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const draft = parsed as Partial<SessionDraft>;
    if (
      typeof draft.generationId !== "number" ||
      typeof draft.teamName !== "string" ||
      !Array.isArray(draft.members)
    ) {
      return null;
    }

    return {
      generationId: draft.generationId,
      teamName: draft.teamName,
      currentTeamId: typeof draft.currentTeamId === "string" ? draft.currentTeamId : null,
      members: draft.members as TeamMember[]
    };
  } catch {
    return null;
  }
}

function persistSessionDraft(draft: SessionDraft) {
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(draft));
}
