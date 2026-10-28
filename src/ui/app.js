// RequireFlow Vanilla Client Application
import { createEl, safeColor } from "./safe-dom.js";

const state = {
  projects: [],
  currentProject: null,
  sections: [],
  activeTab: "overview",
  activeSectionFilter: null,
  kanbanData: { todo: [], in_progress: [], done: [] },
  ideas: { projectId: null, ideas: [], epics: [], stories: [], ungrouped: [] },
  groups: [],
  selectedGroupId: null,
  selectedGroupDetail: null,
  groupFilter: "all",
  epics: [],
  planning: { ideas: [], epics: [], stories: [], ungrouped: [] },
  overviewMap: "groups",
  editMode: false,
  backlogTasks: [],
  historyData: { items: [], total: 0, page: 1, limit: 20 },
  metrics: null,
  searchDebounceTimer: null,
};

const GROUP_STATUS_LABELS = {
  planificado: "Planificado",
  en_refinamiento: "En refinamiento",
  listo_para_aprobacion: "Listo para aprobar",
  aprobado: "Aprobado",
  en_implementacion: "En implementación",
  pendiente_revision_humana: "Pendiente de revisión",
  en_correcciones: "En correcciones",
  aceptado: "Aceptado",
  bloqueado: "Bloqueado",
};

const GROUP_FILTERS = [
  { key: "all", label: "Todos" },
  { key: "provisional", label: "Provisionales", statuses: ["planificado", "en_refinamiento"] },
  { key: "approval", label: "Por aprobar", statuses: ["listo_para_aprobacion"] },
  { key: "running", label: "En ejecución", statuses: ["aprobado", "en_implementacion"] },
  { key: "review", label: "En revisión", statuses: ["pendiente_revision_humana", "en_correcciones"] },
  { key: "accepted", label: "Aceptados", statuses: ["aceptado"] },
  { key: "blocked", label: "Bloqueados", statuses: ["bloqueado"] },
];

  // --- API Client ---
  // The mutation token is issued per server process and read from the
  // origin-restricted health endpoint; another site cannot read it.
  let apiToken = null;

  async function ensureApiToken() {
    if (apiToken) return apiToken;
    try {
      const res = await fetch("/api/health");
      if (res.ok) {
        const data = await res.json();
        apiToken = data.token || null;
      }
    } catch {
      apiToken = null;
    }
    return apiToken;
  }

  async function fetchAPI(endpoint, options = {}) {
    try {
      const method = (options.method || "GET").toUpperCase();
      const headers = {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      };

      if (method !== "GET" && method !== "HEAD") {
        const token = await ensureApiToken();
        if (token) headers["X-RequireFlow-Token"] = token;
      }

      const res = await fetch(endpoint, { ...options, method, headers });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${res.status}`);
      }

      return await res.json();
    } catch (err) {
      showToast(err.message, "error");
      throw err;
    }
  }

  // --- Toasts ---
  function showToast(message, type = "success") {
    const container = document.getElementById("toastContainer");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.append(
      createEl("span", { text: type === "success" ? "✓" : "⚠️" }),
      createEl("span", { text: message })
    );
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 200);
    }, 3000);
  }

  // --- Theme ---
  function initTheme() {
    const saved = localStorage.getItem("rf_theme") || "dark";
    document.documentElement.setAttribute("data-theme", saved);
    updateThemeUI(saved);

    const toggleBtn = document.getElementById("themeToggle");
    toggleBtn?.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("rf_theme", next);
      updateThemeUI(next);
    });
  }

  function updateThemeUI(theme) {
    const icon = document.getElementById("themeIcon");
    const text = document.getElementById("themeText");
    if (icon && text) {
      if (theme === "dark") {
        icon.textContent = "☀️";
        text.textContent = "Modo Claro";
      } else {
        icon.textContent = "🌙";
        text.textContent = "Modo Oscuro";
      }
    }
  }

  // --- Helpers ---
  function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return "0s";
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0 || parts.length === 0) parts.push(`${s}s`);
    return parts.slice(0, 2).join(" ");
  }

  function formatDate(isoString) {
    if (!isoString) return "-";
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return isoString;
    }
  }

  // --- Project Initialization ---
  async function loadProjects() {
    state.projects = await fetchAPI("/api/projects");

    if (state.projects.length === 0) {
      // Detection is read-only: it never registers a project behind the user's back.
      const detected = await detectCurrentProject();
      if (detected) {
        state.projects = [detected];
        state.currentProject = detected;
      } else {
        state.currentProject = null;
        showToast("No hay proyecto vinculado. Creá uno desde el gestor de proyectos.", "error");
      }
    } else if (!state.currentProject) {
      state.currentProject = state.projects[0];
    }

    renderProjectSelector();

    if (!state.currentProject) {
      const pathEl = document.getElementById("projectRootPath");
      if (pathEl) pathEl.textContent = "Sin proyecto vinculado";
      return;
    }

    await loadProjectSections();
    await loadActiveTabData();
  }

  async function detectCurrentProject() {
    try {
      const res = await fetch("/api/projects/current");
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function renderProjectSelector() {
    const select = document.getElementById("projectSelect");
    if (!select) return;

    select.innerHTML = "";
    for (const p of state.projects) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      if (state.currentProject && p.id === state.currentProject.id) {
        opt.selected = true;
      }
      select.appendChild(opt);
    }

    const modeBadge = document.getElementById("projectModeBadge");
    if (modeBadge && state.currentProject) {
      modeBadge.textContent = state.currentProject.mode || "legacy";
      modeBadge.classList.toggle("mode-product", state.currentProject.mode === "product");
    }

    const pathEl = document.getElementById("projectRootPath");
    if (pathEl && state.currentProject) {
      pathEl.textContent = state.currentProject.root_path || "Sin ruta de repositorio";
      pathEl.title = state.currentProject.root_path || "";
    }
  }

  async function loadProjectSections() {
    if (!state.currentProject) return;
    state.sections = await fetchAPI(`/api/projects/${state.currentProject.id}/sections`);
    renderSectionFilterBar();
    populateSectionSelects();
  }

  function renderSectionFilterBar() {
    const bar = document.getElementById("sectionFilterBar");
    if (!bar) return;

    bar.innerHTML = "";

    const allChip = document.createElement("button");
    allChip.className = `section-chip ${!state.activeSectionFilter ? "active" : ""}`;
    allChip.textContent = "Todas las secciones";
    allChip.addEventListener("click", () => {
      state.activeSectionFilter = null;
      renderSectionFilterBar();
      loadActiveTabData();
    });
    bar.appendChild(allChip);

    for (const sec of state.sections) {
      const chip = document.createElement("button");
      chip.className = `section-chip ${state.activeSectionFilter === sec.id ? "active" : ""}`;
      chip.append(
        createEl("span", {
          class: "section-dot",
          style: { "background-color": safeColor(sec.color) },
        }),
        document.createTextNode(` ${sec.name}`)
      );
      chip.addEventListener("click", () => {
        state.activeSectionFilter = state.activeSectionFilter === sec.id ? null : sec.id;
        renderSectionFilterBar();
        loadActiveTabData();
      });
      bar.appendChild(chip);
    }
  }

  function populateSectionSelects() {
    const select = document.getElementById("taskSectionSelect");
    if (!select) return;

    select.innerHTML = '<option value="">(Sin sección)</option>';
    for (const sec of state.sections) {
      const opt = document.createElement("option");
      opt.value = sec.id;
      opt.textContent = sec.name;
      select.appendChild(opt);
    }
  }

  // --- Tab Navigation ---
  function switchTab(tab) {
    document.querySelectorAll(".sidebar-nav .nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-tab") === tab);
    });

    state.activeTab = tab;
    document.querySelectorAll(".view-panel").forEach((panel) => {
      panel.classList.remove("active");
    });
    document.getElementById(`view${capitalize(tab)}`)?.classList.add("active");

    const titles = {
      overview: "Resumen del producto",
      kanban: "Tablero Kanban",
      ideas: "Ideas",
      groups: "Grupos de experiencia",
      backlog: "Backlog & Secciones",
      history: "Historial Permanente",
      metrics: "Eficiencia y Métricas",
      projects: "Gestor de Proyectos",
    };
    const titleEl = document.getElementById("currentTabTitle");
    if (titleEl) titleEl.textContent = titles[tab] || "RequireFlow";

    const showsSections = tab === "kanban" || tab === "backlog";
    const filterBar = document.getElementById("sectionFilterBar");
    if (filterBar) filterBar.style.display = showsSections ? "flex" : "none";

    const newTaskButton = document.getElementById("btnOpenNewTask");
    if (newTaskButton) newTaskButton.hidden = !(tab === "kanban" || tab === "backlog");

    loadActiveTabData();
  }

  function initTabs() {
    document.querySelectorAll(".sidebar-nav .nav-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-tab");
        if (tab) switchTab(tab);
      });
    });

    const newTaskButton = document.getElementById("btnOpenNewTask");
    if (newTaskButton) newTaskButton.hidden = true;
  }

  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function groupStatusLabel(status) {
    return GROUP_STATUS_LABELS[status] ?? status ?? "sin estado";
  }

  function statusBadge(status) {
    return createEl("span", {
      class: `badge status-badge status-${status}`,
      text: groupStatusLabel(status),
    });
  }

  function groupTitle(group) {
    return group.name || group.goal || "(sin nombre)";
  }

  function epicForStory(story) {
    if (!story || !story.parent_id) return null;
    return (state.planning.epics ?? []).find((epic) => epic.id === story.parent_id) ?? null;
  }

  function groupsForStory(storyId) {
    return state.groups
      .filter((view) => view.stories.some((story) => story.id === storyId))
      .map((view) => view.increment.code);
  }

  function groupBlockReason(view) {
    const group = view.increment;
    if (view.readiness && !view.readiness.ready && view.readiness.blockers.length > 0) {
      return view.readiness.blockers.join(" · ");
    }
    if (group.status === "planificado" || group.status === "en_refinamiento") {
      return "Falta refinamiento antes de aprobar el alcance.";
    }
    if (view.drifted) return "El alcance cambió después de la aprobación; requiere nueva aprobación.";
    if (group.status === "bloqueado") return "El grupo está bloqueado.";
    if (group.status === "aceptado") return "Aceptado por revisión humana.";
    if (group.status === "pendiente_revision_humana") return "Esperando tu prueba y aceptación.";
    if (group.status === "en_correcciones") return "Hay un defecto reportado en corrección.";
    return "";
  }

  function nextActionLabel(action) {
    const labels = {
      refine: "Refinar alcance",
      request_approval: "Pedir aprobación",
      implement: "Listo para implementar",
      await_review: "Esperando revisión",
      fix: "Corregir defecto",
      done: "Terminado",
      blocked: "Bloqueado",
    };
    return labels[action] ?? action ?? "";
  }

  function renderChips(items, className = "chip-row") {
    const row = createEl("div", { class: className });
    for (const item of items) row.append(item);
    return row;
  }

  // --- 1a. Overview: supervision first ---
  async function loadOverview() {
    if (!state.currentProject) return;
    const [groups, planning] = await Promise.all([
      fetchAPI(`/api/projects/${state.currentProject.id}/groups`),
      fetchAPI(`/api/projects/${state.currentProject.id}/planning`),
    ]);
    state.groups = groups;
    state.planning = planning;
    state.epics = planning.epics ?? [];
    renderOverview();
    renderOverviewMap();
  }

  function renderOverview() {
    const summary = document.getElementById("overviewSummary");
    const strip = document.getElementById("overviewStatusStrip");
    const grid = document.getElementById("overviewGroups");
    const count = document.getElementById("overviewGroupCount");
    const empty = document.getElementById("overviewEmpty");
    if (!summary || !strip || !grid) return;

    const project = state.currentProject;
    const groups = state.groups;
    const storyCount = groups.reduce((total, view) => total + view.stories.length, 0);
    const criteriaCount = groups.reduce((total, view) => total + view.acceptanceCriteria.length, 0);
    const accepted = groups.filter((view) => view.increment.status === "aceptado").length;

    summary.innerHTML = "";
    summary.append(
      createEl("div", { class: "summary-main" }, [
        createEl("p", { class: "eyebrow-sm", text: "Supervisión del producto" }),
        createEl("h2", { text: project?.name || "Proyecto" }),
        createEl("p", { class: "surface-sub", text: project?.root_path || "" }),
      ]),
      createEl("div", { class: "summary-stats" }, [
        createEl("div", { class: "stat" }, [
          createEl("span", { class: "stat-value", text: String(groups.length) }),
          createEl("span", { class: "stat-label", text: "grupos" }),
        ]),
        createEl("div", { class: "stat" }, [
          createEl("span", { class: "stat-value", text: String(storyCount) }),
          createEl("span", { class: "stat-label", text: "historias" }),
        ]),
        createEl("div", { class: "stat" }, [
          createEl("span", { class: "stat-value", text: String(criteriaCount) }),
          createEl("span", { class: "stat-label", text: "criterios" }),
        ]),
        createEl("div", { class: "stat" }, [
          createEl("span", { class: "stat-value", text: String(accepted) }),
          createEl("span", { class: "stat-label", text: "aceptados" }),
        ]),
      ])
    );

    strip.innerHTML = "";
    const present = new Set(groups.map((view) => view.increment.status));
    for (const status of Object.keys(GROUP_STATUS_LABELS)) {
      if (!present.has(status)) continue;
      const total = groups.filter((view) => view.increment.status === status).length;
      const chip = createEl("button", {
        class: `status-chip status-${status}`,
        text: `${groupStatusLabel(status)} · ${total}`,
      });
      chip.addEventListener("click", () => {
        state.groupFilter = status === "aceptado" ? "accepted" : "all";
        switchTab("groups");
      });
      strip.append(chip);
    }
    if (strip.childElementCount === 0) {
      strip.append(createEl("span", { class: "surface-sub", text: "Sin grupos todavía." }));
    }

    if (count) count.textContent = String(groups.length);
    grid.innerHTML = "";
    if (empty) empty.toggleAttribute("hidden", groups.length > 0);

    for (const view of groups) {
      grid.append(buildGroupCard(view));
    }
  }

  function buildGroupCard(view) {
    const group = view.increment;
    const card = createEl("article", {
      class: `group-card border-${group.status}`,
      dataset: { code: group.code },
      attrs: { tabindex: "0", role: "button", "aria-label": `${group.code} ${groupTitle(group)}` },
    });

    card.append(
      createEl("div", { class: "group-card-head" }, [
        createEl("span", { class: "group-code", text: group.code }),
        statusBadge(group.status),
      ]),
      createEl("h3", { class: "group-card-title", text: groupTitle(group) }),
      createEl("p", { class: "group-card-meta" }, [
        `${view.stories.length} historias · ${view.acceptanceCriteria.length} criterios`,
      ])
    );

    if (view.dependencies.length > 0) {
      const deps = createEl("div", { class: "dep-row" });
      deps.append(createEl("span", { class: "dep-label", text: "Depende de" }));
      for (const dependency of view.dependencies) deps.append(createEl("span", { class: "dep-chip", text: dependency.code }));
      card.append(deps);
    }

    const reason = groupBlockReason(view);
    if (reason) card.append(createEl("p", { class: "group-card-reason", text: reason }));
    card.append(
      createEl("div", { class: "group-card-foot" }, [
        createEl("span", { class: "next-action", text: nextActionLabel(view.nextAction) }),
        createEl("span", {
          class: `exec-pill ${view.canExecute ? "exec-yes" : "exec-no"}`,
          text: view.canExecute ? "Ejecutable" : "No ejecutable",
        }),
      ])
    );

    const open = () => {
      state.selectedGroupId = group.id;
      switchTab("groups");
    };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });

    return card;
  }

  function renderOverviewMap() {
    const groupsEl = document.getElementById("overviewMapGroups");
    const epicsEl = document.getElementById("overviewMapEpics");
    if (!groupsEl || !epicsEl) return;

    groupsEl.innerHTML = "";
    epicsEl.innerHTML = "";

    for (const view of state.groups) groupsEl.append(buildGroupTree(view));

    if ((state.planning.epics ?? []).length === 0) {
      epicsEl.append(createEl("div", { class: "empty-state", text: "Todavía no hay épicas." }));
    } else {
      for (const epic of state.planning.epics) epicsEl.append(buildEpicTree(epic));
    }

    const showGroups = state.overviewMap === "groups";
    groupsEl.toggleAttribute("hidden", !showGroups);
    epicsEl.toggleAttribute("hidden", showGroups);
    document.getElementById("btnMapByGroup")?.classList.toggle("active", showGroups);
    document.getElementById("btnMapByEpic")?.classList.toggle("active", !showGroups);
    document.getElementById("btnMapByGroup")?.setAttribute("aria-selected", String(showGroups));
    document.getElementById("btnMapByEpic")?.setAttribute("aria-selected", String(!showGroups));
  }

  function buildGroupTree(view) {
    const group = view.increment;
    const node = createEl("details", { class: "tree-node" });
    const summary = createEl("summary", { class: "tree-summary" });
    summary.append(
      createEl("span", { class: "group-code", text: group.code }),
      createEl("strong", { text: groupTitle(group) }),
      statusBadge(group.status)
    );
    node.append(summary);

    const body = createEl("div", { class: "tree-body" });

    const stories = createEl("div", { class: "tree-level" });
    stories.append(createEl("h4", { text: `Historias (${view.stories.length})` }));
    for (const story of view.stories) {
      const epic = epicForStory(story);
      stories.append(
        createEl("div", { class: "tree-row" }, [
          createEl("span", { class: "group-code", text: story.code || "H???" }),
          createEl("span", { class: "tree-row-title", text: story.title }),
          createEl("span", { class: "tree-tag", text: epic ? `${epic.code} · ${epic.title}` : "sin épica" }),
        ])
      );
    }
    body.append(stories);

    const criteria = createEl("div", { class: "tree-level" });
    criteria.append(createEl("h4", { text: `Criterios (${view.acceptanceCriteria.length})` }));
    for (const criterion of view.acceptanceCriteria) {
      criteria.append(
        createEl("div", { class: `tree-row criterion-${criterion.status}` }, [
          createEl("span", { class: "group-code", text: criterion.code }),
          createEl("span", { class: "tree-row-title", text: criterion.text }),
          createEl("span", { class: "tree-tag", text: criterion.status }),
        ])
      );
    }
    body.append(criteria);

    node.append(body);
    return node;
  }

  function buildEpicTree(epic) {
    const node = createEl("details", { class: "tree-node" });
    const summary = createEl("summary", { class: "tree-summary" });
    summary.append(
      createEl("span", { class: "group-code", text: epic.code || "E??" }),
      createEl("strong", { text: epic.title }),
      createEl("span", { class: "badge", text: epic.status })
    );
    node.append(summary);

    const body = createEl("div", { class: "tree-body" });
    const stories = createEl("div", { class: "tree-level" });
    for (const story of epic.stories ?? []) {
      const memberships = groupsForStory(story.id);
      stories.append(
        createEl("div", { class: "tree-row" }, [
          createEl("span", { class: "group-code", text: story.code || "H???" }),
          createEl("span", { class: "tree-row-title", text: story.title }),
          createEl("span", {
            class: "tree-tag",
            text: memberships.length > 0 ? `en ${memberships.join(", ")}` : "fuera de grupos",
          }),
        ])
      );
    }
    if (stories.childElementCount === 0) {
      stories.append(createEl("div", { class: "surface-sub", text: "Esta épica no tiene historias." }));
    }
    body.append(stories);
    node.append(body);
    return node;
  }

  function initOverviewMap() {
    document.getElementById("btnMapByGroup")?.addEventListener("click", () => {
      state.overviewMap = "groups";
      renderOverviewMap();
    });
    document.getElementById("btnMapByEpic")?.addEventListener("click", () => {
      state.overviewMap = "epics";
      renderOverviewMap();
    });
  }

  async function loadActiveTabData() {
    if (!state.currentProject) return;

    switch (state.activeTab) {
      case "overview":
        await loadOverview();
        break;
      case "kanban":
        await loadKanban();
        break;
      case "ideas":
        await loadIdeas();
        break;
      case "groups":
        await loadGroups();
        break;
      case "backlog":
        await loadBacklog();
        break;
      case "history":
        await loadHistory();
        break;
      case "metrics":
        await loadMetrics();
        break;
      case "projects":
        renderProjectsManager();
        break;
    }
  }

  // --- 1b. Ideas (fast capture) ---
  async function loadIdeas() {
    if (!state.currentProject) return;
    state.ideas = await fetchAPI(`/api/projects/${state.currentProject.id}/planning`);
    renderIdeas();
  }

  function renderIdeas() {
    const list = document.getElementById("ideasList");
    const count = document.getElementById("ideasCount");
    if (!list) return;

    const ideas = state.ideas?.ideas ?? [];
    if (count) count.textContent = ideas.length;

    list.innerHTML = "";
    if (ideas.length === 0) {
      list.append(
        createEl("div", {
          class: "empty-state",
          text: "Todavía no hay ideas. Anotá la primera arriba, sin convertirla en trabajo.",
        })
      );
      return;
    }

    for (const idea of ideas) {
      const card = createEl("article", { class: "idea-card", dataset: { id: idea.id } });
      card.append(
        createEl("div", { class: "idea-card-head" }, [
          createEl("span", { class: "badge badge-idea-status", text: idea.status }),
          createEl("span", { class: `badge badge-definition badge-definition-${idea.definition}`, text: idea.definition }),
          createEl("span", { class: "idea-date", text: formatDate(idea.created_at) }),
        ]),
        createEl("h3", { class: "idea-title", text: idea.title }),
        createEl("pre", { class: "idea-original", text: idea.original_text })
      );
      list.append(card);
    }
  }

  function initIdeaCapture() {
    const form = document.getElementById("formIdea");
    const input = document.getElementById("ideaTextInput");
    if (!form || !input) return;

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!state.currentProject) {
        showToast("No hay proyecto activo.", "error");
        return;
      }

      const text = input.value.trim();
      if (text === "") {
        showToast("Escribí la idea antes de guardarla.", "error");
        return;
      }

      try {
        const result = await fetchAPI(`/api/projects/${state.currentProject.id}/ideas`, {
          method: "POST",
          body: JSON.stringify({ text }),
        });
        input.value = "";
        if (result.duplicate_of) {
          showToast("Idea guardada. Ya existía una idea idéntica.", "error");
        } else {
          showToast("Idea guardada. No se creó trabajo ejecutable.", "success");
        }
        await loadIdeas();
      } catch {
        // fetchAPI already surfaced the error.
      }
    });
  }

  // --- 1c. Product groups ---
  async function loadGroups() {
    if (!state.currentProject) return;
    const [groups, planning] = await Promise.all([
      fetchAPI(`/api/projects/${state.currentProject.id}/groups`),
      fetchAPI(`/api/projects/${state.currentProject.id}/planning`),
    ]);
    state.groups = groups;
    state.planning = planning;
    state.epics = planning.epics ?? [];

    if (
      state.selectedGroupId === null ||
      !state.groups.some((view) => view.increment.id === state.selectedGroupId)
    ) {
      state.selectedGroupId = state.groups[0]?.increment.id ?? null;
    }

    renderGroupFilters();
    renderGroups();
    renderEpics();
    await loadGroupDetail();
  }

  async function loadGroupDetail() {
    if (!state.selectedGroupId) {
      state.selectedGroupDetail = null;
      renderGroupDetail();
      return;
    }
    try {
      state.selectedGroupDetail = await fetchAPI(`/api/groups/${state.selectedGroupId}`);
    } catch {
      state.selectedGroupDetail = null;
    }
    renderGroupDetail();
  }

  function renderGroupFilters() {
    const box = document.getElementById("groupFilters");
    if (!box) return;
    box.innerHTML = "";

    for (const filter of GROUP_FILTERS) {
      const total =
        filter.key === "all"
          ? state.groups.length
          : state.groups.filter((view) => (filter.statuses ?? []).includes(view.increment.status)).length;
      const chip = createEl("button", {
        class: `filter-chip ${state.groupFilter === filter.key ? "active" : ""}`,
        text: `${filter.label} · ${total}`,
      });
      chip.addEventListener("click", () => {
        state.groupFilter = filter.key;
        renderGroupFilters();
        renderGroups();
      });
      box.append(chip);
    }
  }

  function filteredGroups() {
    const filter = GROUP_FILTERS.find((entry) => entry.key === state.groupFilter);
    if (!filter || !filter.statuses) return state.groups;
    return state.groups.filter((view) => filter.statuses.includes(view.increment.status));
  }

  function renderGroups() {
    const list = document.getElementById("groupsList");
    if (!list) return;
    list.innerHTML = "";

    if (state.groups.length === 0) {
      list.append(
        createEl("div", {
          class: "empty-state",
          text: "No hay grupos todavía. La skill de product-backlog los propone y los guarda.",
        })
      );
      return;
    }

    const visible = filteredGroups();
    if (visible.length === 0) {
      list.append(createEl("div", { class: "empty-state", text: "Ningún grupo coincide con este filtro." }));
      return;
    }

    for (const view of visible) {
      const group = view.increment;
      const button = createEl("button", {
        class: `group-item ${state.selectedGroupId === group.id ? "active" : ""}`,
        dataset: { id: group.id },
      });
      const head = createEl("div", { class: "group-item-head" }, [
        createEl("span", { class: "group-code", text: group.code }),
        statusBadge(group.status),
      ]);
      if (view.drifted) {
        head.append(createEl("span", { class: "group-drift", text: "⚠ deriva" }));
      }
      button.append(
        head,
        createEl("div", { class: "group-item-name", text: groupTitle(group) }),
        createEl("div", {
          class: "group-item-meta",
          text: `${view.stories.length} historias · ${view.acceptanceCriteria.length} criterios`,
        })
      );
      button.addEventListener("click", async () => {
        state.selectedGroupId = group.id;
        state.editMode = false;
        renderGroups();
        await loadGroupDetail();
      });
      list.append(button);
    }
  }

  function renderEpics() {
    const list = document.getElementById("epicsList");
    if (!list) return;
    list.innerHTML = "";

    if (!state.epics || state.epics.length === 0) {
      list.append(createEl("div", { class: "empty-state", text: "Todavía no hay épicas." }));
      return;
    }

    for (const epic of state.epics) {
      const card = createEl("div", { class: "epic-card" });
      card.append(
        createEl("div", { class: "group-item-head" }, [
          createEl("span", { class: "group-code", text: epic.code || "E??" }),
          createEl("span", { class: "badge", text: epic.status }),
        ]),
        createEl("div", { class: "group-item-name", text: epic.title })
      );
      for (const story of epic.stories ?? []) {
        const memberships = groupsForStory(story.id);
        card.append(
          createEl("div", { class: "epic-story" }, [
            createEl("span", { class: "group-code", text: story.code || "H???" }),
            document.createTextNode(` ${story.title} `),
            createEl("span", { class: "badge", text: story.status }),
            createEl("span", {
              class: "tree-tag",
              text: memberships.length > 0 ? ` ${memberships.join(", ")}` : " fuera de grupos",
            }),
          ])
        );
      }
      list.append(card);
    }
  }

  function detailView() {
    const detail = state.selectedGroupDetail;
    const fromList = state.groups.find((entry) => entry.increment.id === state.selectedGroupId);
    if (detail && fromList && detail.increment.id === fromList.increment.id) {
      return { ...fromList, ...detail };
    }
    return detail ?? fromList ?? null;
  }

  function buildSection(title, children, options = {}) {
    const section = createEl("section", { class: `group-section ${options.class || ""}`.trim() });
    const head = createEl("div", { class: "section-head" }, [createEl("h3", { text: title })]);
    if (options.count !== undefined) {
      head.append(createEl("span", { class: "count-pill", text: String(options.count) }));
    }
    section.append(head);
    section.append(...children);
    return section;
  }

  function renderGroupDetail() {
    const detail = document.getElementById("groupDetail");
    if (!detail) return;
    detail.innerHTML = "";

    const view = detailView();
    if (!view) {
      detail.append(createEl("div", { class: "empty-state", text: "Seleccioná un grupo para ver su alcance." }));
      return;
    }

    const group = view.increment;
    const criteria = view.acceptanceCriteria ?? [];
    const activeCriteria = criteria.filter((criterion) => criterion.status === "active");
    const supersededCriteria = criteria.filter((criterion) => criterion.status === "superseded");
    const retiredCriteria = criteria.filter((criterion) => criterion.status === "retired");

    const head = createEl("header", { class: "group-detail-head" });
    const badgeRow = createEl("div", { class: "group-badges" }, [
      statusBadge(group.status),
      createEl("span", { class: "badge badge-quiet", text: `revisión actual ${group.version}` }),
      createEl("span", { class: "badge badge-quiet", text: `aprobada ${group.approved_revision || 0}` }),
    ]);
    if (view.drifted) badgeRow.append(createEl("span", { class: "badge badge-warning", text: "⚠ alcance derivado" }));
    badgeRow.append(
      createEl("span", {
        class: `badge ${view.canExecute ? "badge-success" : "badge-quiet"}`,
        text: view.canExecute ? "Ejecutable" : "No ejecutable",
      })
    );

    head.append(
      createEl("div", { class: "detail-kicker" }, [
        createEl("span", { class: "group-code", text: group.code }),
        createEl("span", { class: "detail-next", text: nextActionLabel(view.nextAction) }),
      ]),
      createEl("h2", { text: groupTitle(group) }),
      badgeRow,
      createEl("p", { class: "group-goal", text: group.goal || "Sin objetivo definido." })
    );

    const reason = groupBlockReason(view);
    if (reason) head.append(createEl("p", { class: "group-reason", text: reason }));

    if (view.dependencies.length > 0) {
      const deps = createEl("div", { class: "dep-row" });
      deps.append(createEl("span", { class: "dep-label", text: "Depende de" }));
      for (const dependency of view.dependencies) {
        deps.append(
          createEl("span", { class: "dep-chip", text: `${dependency.code} · ${groupStatusLabel(dependency.status)}` })
        );
      }
      head.append(deps);
    }

    head.append(
      createEl("div", { class: "detail-meta" }, [
        createEl("span", { text: `Historias: ${view.stories.length}` }),
        createEl("span", { text: `Criterios activos: ${activeCriteria.length}` }),
        createEl("span", { text: `Decisión(es): ${(view.decisions ?? []).length}` }),
        createEl("span", { text: `Aprobada: ${group.approved_at ? formatDate(group.approved_at) : "sin aprobar"}` }),
      ])
    );

    const actions = buildGroupActions(view);
    if (actions) head.append(actions);
    detail.append(head);

    detail.append(
      buildSection(
        "Historias",
        view.stories.length === 0
          ? [createEl("div", { class: "empty-state", text: "Este grupo todavía no tiene historias." })]
          : view.stories.map((story) => buildStoryRow(story)),
        { count: view.stories.length }
      )
    );

    const criteriaNodes = [];
    if (activeCriteria.length > 0) {
      criteriaNodes.push(createEl("h4", { class: "subhead", text: "Activos" }));
      for (const criterion of activeCriteria) criteriaNodes.push(buildCriterionRow(criterion, criteria, view));
    }
    if (supersededCriteria.length > 0) {
      criteriaNodes.push(createEl("h4", { class: "subhead", text: "Sustituidos" }));
      for (const criterion of supersededCriteria) criteriaNodes.push(buildCriterionRow(criterion, criteria, view));
    }
    if (retiredCriteria.length > 0) {
      criteriaNodes.push(createEl("h4", { class: "subhead", text: "Retirados" }));
      for (const criterion of retiredCriteria) criteriaNodes.push(buildCriterionRow(criterion, criteria, view));
    }
    if (criteria.length === 0) {
      criteriaNodes.push(createEl("div", { class: "empty-state", text: "Sin criterios de aceptación todavía." }));
    } else {
      criteriaNodes.push(
        createEl("p", {
          class: "surface-sub",
          text: "El dominio actual no vincula cada criterio a una historia concreta: pertenecen al grupo aprobado.",
        })
      );
    }
    detail.append(buildSection("Criterios de aceptación", criteriaNodes, { count: criteria.length }));

    detail.append(
      buildSection(
        "Decisiones",
        (view.decisions ?? []).length === 0
          ? [createEl("div", { class: "empty-state", text: "Sin decisiones registradas." })]
          : view.decisions.map((decision) => buildDecisionRow(decision)),
        { count: (view.decisions ?? []).length }
      )
    );

    detail.append(
      buildSection("Fuera de alcance", [
        createEl("p", {
          class: "prose",
          text: view.exclusiones || "Este grupo no declara exclusiones.",
        }),
      ])
    );

    const blockerNodes = (view.readiness?.blockers ?? []).map((blocker) =>
      createEl("div", { class: "blocker", text: `! ${blocker}` })
    );
    detail.append(
      buildSection(
        "Dudas y bloqueos pendientes",
        view.readiness?.ready
          ? [createEl("div", { class: "empty-state", text: "Sin dudas bloqueantes. El grupo está listo según el dominio." })]
          : blockerNodes,
        { count: view.readiness?.blockers?.length ?? 0 }
      )
    );

    detail.append(buildReviewsSection(view));

    if (state.editMode) detail.append(buildEditPanel(view));
  }

  function buildStoryRow(story) {
    const epic = epicForStory(story);
    const row = createEl("article", { class: "story-row" });
    row.append(
      createEl("div", { class: "story-head" }, [
        createEl("span", { class: "group-code", text: story.code || "H???" }),
        createEl("strong", { class: "story-title", text: story.title }),
        createEl("span", { class: "badge", text: story.status }),
      ]),
      createEl("div", { class: "story-meta" }, [
        createEl("span", { class: "tree-tag", text: epic ? `${epic.code} · ${epic.title}` : "sin épica" }),
        createEl("span", { class: "tree-tag", text: `origen: ${story.origin}` }),
      ])
    );
    if (story.description) {
      row.append(createEl("p", { class: "prose story-description", text: story.description }));
    }
    return row;
  }

  function buildCriterionRow(criterion, allCriteria, view) {
    const row = createEl("article", { class: `criterion-row criterion-${criterion.status}` });
    row.append(
      createEl("div", { class: "criterion-head" }, [
        createEl("span", { class: "group-code", text: criterion.code }),
        createEl("span", { class: `badge status-criterion-${criterion.status}`, text: criterion.status }),
      ]),
      createEl("p", { class: "criterion-text", text: criterion.text })
    );

    if (criterion.status === "superseded" && criterion.superseded_by) {
      const replacement = allCriteria.find((entry) => entry.id === criterion.superseded_by);
      row.append(
        createEl("p", { class: "criterion-trace", text: `Sustituido por ${replacement?.code || criterion.superseded_by}` })
      );
    }

    if (state.editMode && criterion.status === "active") {
      const actions = createEl("div", { class: "criterion-actions" });
      const supersede = createEl("button", { class: "btn-secondary btn-sm", text: "Sustituir" });
      supersede.addEventListener("click", async () => {
        const text = window.prompt(`Nuevo texto para ${criterion.code} (el criterio anterior queda en el historial):`);
        if (!text || text.trim() === "") return;
        await submitEdit(`/api/criteria/${criterion.id}`, "PATCH", {
          expectedVersion: criterion.version,
          text: text.trim(),
        });
      });
      const retire = createEl("button", { class: "btn-danger btn-sm", text: "Retirar" });
      retire.addEventListener("click", async () => {
        const reason = window.prompt(`Motivo para retirar ${criterion.code}:`);
        if (!reason || reason.trim() === "") return;
        await submitEdit(`/api/criteria/${criterion.id}`, "DELETE", {
          expectedVersion: criterion.version,
          reason: reason.trim(),
        });
      });
      actions.append(supersede, retire);
      row.append(actions);
    }

    return row;
  }

  function buildDecisionRow(decision) {
    const row = createEl("details", { class: "decision-row" });
    row.append(
      createEl("summary", { class: "decision-summary" }, [
        createEl("span", { class: "group-code", text: decision.code }),
        createEl("strong", { text: decision.title }),
        createEl("span", { class: "badge", text: decision.status }),
      ])
    );
    const body = createEl("div", { class: "decision-body" });
    body.append(
      createEl("p", { class: "prose" }, [createEl("strong", { text: "Pregunta: " }), decision.question]),
      createEl("p", { class: "prose" }, [createEl("strong", { text: "Respuesta: " }), decision.answer])
    );
    if (decision.alternatives) {
      body.append(createEl("p", { class: "prose" }, [createEl("strong", { text: "Alternativas: " }), decision.alternatives]));
    }
    if (decision.impact) {
      body.append(createEl("p", { class: "prose" }, [createEl("strong", { text: "Impacto: " }), decision.impact]));
    }
    row.append(body);
    return row;
  }

  function buildReviewsSection(view) {
    const reviews = view.reviews ?? [];
    const nodes = [];

    const latest = view.latestReview;
    if (latest) {
      const latestBox = createEl("div", { class: "review-latest" });
      latestBox.append(
        createEl("div", { class: "review-latest-head" }, [
          createEl("strong", { text: `Ciclo ${latest.cycle} · ${latest.status}` }),
          createEl("span", { class: "surface-sub", text: formatDate(latest.requested_at) }),
        ]),
        createEl("p", { class: "prose review-evidence", text: latest.evidence || "Sin evidencia registrada todavía." })
      );
      nodes.push(latestBox);
    } else if (view.increment.status === "pendiente_revision_humana" || view.increment.status === "en_correcciones") {
      nodes.push(createEl("div", { class: "surface-sub", text: "No se encontró evidencia de implementación." }));
    }

    if (reviews.length > 0) {
      const timeline = createEl("div", { class: "review-timeline" });
      for (const review of reviews) {
        const entry = createEl("details", { class: "review-entry" });
        entry.append(
          createEl("summary", { class: "review-entry-head" }, [
            createEl("span", { class: "group-code", text: `Ciclo ${review.cycle}` }),
            createEl("span", { class: `badge status-review-${review.status}`, text: review.status }),
            createEl("span", { class: "surface-sub", text: formatDate(review.requested_at) }),
          ])
        );
        const body = createEl("div", { class: "review-entry-body" });
        if (review.evidence) body.append(createEl("p", { class: "prose", text: review.evidence }));
        if (review.notes) body.append(createEl("p", { class: "prose" }, [createEl("strong", { text: "Notas: " }), review.notes]));
        for (const finding of review.findings ?? []) {
          body.append(
            createEl("div", { class: `finding finding-${finding.status}` }, [
              createEl("span", { class: "badge badge-warning", text: `${finding.kind} · ${finding.status}` }),
              createEl("p", { class: "prose", text: finding.description }),
            ])
          );
        }
        for (const result of review.results ?? []) {
          body.append(
            createEl("div", { class: "review-result" }, [
              createEl("span", { class: "badge badge-quiet", text: "resultado" }),
              createEl("p", { class: "prose", text: result.summary || result.outcome || JSON.stringify(result) }),
            ])
          );
        }
        entry.append(body);
        timeline.append(entry);
      }
      nodes.push(timeline);
    }

    return buildSection("Evidencias y revisiones", nodes.length > 0 ? nodes : [
      createEl("div", { class: "empty-state", text: "Sin ciclos de revisión todavía." }),
    ], { count: reviews.length });
  }

  function buildGroupActions(view) {
    const group = view.increment;
    const actions = createEl("div", { class: "group-actions" });

    const editToggle = createEl("button", {
      class: `btn-secondary btn-sm ${state.editMode ? "active" : ""}`,
      text: state.editMode ? "Salir de edición" : "Modo edición",
      attrs: { "aria-pressed": String(state.editMode) },
    });
    editToggle.addEventListener("click", () => {
      state.editMode = !state.editMode;
      renderGroupDetail();
    });
    actions.append(editToggle);

    if (group.status === "listo_para_aprobacion" || view.drifted) {
      const approve = createEl("button", { class: "btn-primary", text: "Aprobar alcance" });
      approve.addEventListener("click", () =>
        askHumanConfirmation({
          title: `Aprobar ${group.code}`,
          message: `Vas a aprobar la revisión vigente de ${group.code} con ${view.stories.length} historias y ${view.acceptanceCriteria.length} criterios. La implementación no empieza hasta que ODD tome el grupo.`,
          expected: `APROBAR ${group.code}`,
          onConfirm: (phrase) =>
            groupAction(group.id, "approve", {
              expectedVersion: group.version,
              confirm: phrase,
            }),
        })
      );
      actions.append(approve);
    }

    if (group.status === "aprobado" && !view.drifted) {
      const start = createEl("button", { class: "btn-secondary", text: "Iniciar implementación" });
      start.addEventListener("click", () => groupAction(group.id, "start", {}));
      actions.append(start);
    }

    if (group.status === "pendiente_revision_humana") {
      const accept = createEl("button", { class: "btn-primary", text: "Aceptar grupo" });
      accept.addEventListener("click", () =>
        askHumanConfirmation({
          title: `Aceptar ${group.code}`,
          message: "Confirmá que probaste el resultado y que los criterios se cumplen. Un test verde no es aceptación.",
          expected: `ACEPTAR ${group.code}`,
          onConfirm: (phrase) =>
            groupAction(group.id, "accept", {
              expectedVersion: group.version,
              confirm: phrase,
            }),
        })
      );
      actions.append(accept);
    }

    if (group.status === "pendiente_revision_humana") {
      const defectBox = createEl("div", { class: "group-defect" });
      const defectInput = createEl("textarea", {
        class: "form-textarea",
        rows: "2",
        placeholder: "Describí el defecto observado (qué criterio falla y cómo se reproduce)",
        attrs: { "aria-label": "Descripción del defecto" },
      });
      const reportButton = createEl("button", { class: "btn-danger", text: "Reportar defecto" });
      reportButton.addEventListener("click", async () => {
        const description = defectInput.value.trim();
        if (description === "") {
          showToast("Describí el defecto antes de reportarlo.", "error");
          return;
        }
        await groupAction(group.id, "defects", { description });
      });
      defectBox.append(defectInput, reportButton);
      actions.append(defectBox);
    }

    return actions;
  }

  function buildEditPanel(view) {
    const group = view.increment;
    const panel = createEl("section", { class: "edit-panel" });
    panel.append(
      createEl("header", { class: "edit-head" }, [
        createEl("h3", { text: "Edición manual (opcional)" }),
        createEl("p", {
          class: "surface-sub",
          text: "El agente organiza el backlog; esto existe solo para ajustes puntuales. Toda edición envía expectedVersion y el dominio rechaza cambios sobre alcances aprobados o desactualizados.",
        }),
      ])
    );

    const refineForm = createEl("form", { class: "edit-form" });
    refineForm.append(createEl("h4", { text: "Objetivo y exclusiones del grupo" }));
    const nameInput = createEl("input", { class: "form-input", attrs: { placeholder: "Nombre del grupo", "aria-label": "Nombre del grupo" } });
    nameInput.value = group.name ?? "";
    const goalInput = createEl("textarea", { class: "form-textarea", rows: "2", attrs: { placeholder: "Objetivo funcional", "aria-label": "Objetivo del grupo" } });
    goalInput.value = group.goal ?? "";
    const exclusionsInput = createEl("textarea", { class: "form-textarea", rows: "2", attrs: { placeholder: "Fuera de alcance", "aria-label": "Exclusiones" } });
    exclusionsInput.value = group.exclusiones ?? "";
    const depsInput = createEl("input", { class: "form-input", attrs: { placeholder: "Agregar dependencias por código, ej: G02, G03", "aria-label": "Dependencias a agregar" } });
    const refineSubmit = createEl("button", { class: "btn-secondary btn-sm", text: "Guardar cambios del grupo" });
    refineForm.append(nameInput, goalInput, exclusionsInput, depsInput, refineSubmit);
    refineForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const dependencyCodes = depsInput.value
        .split(",")
        .map((code) => code.trim())
        .filter(Boolean);
      await submitEdit(`/api/groups/${group.id}`, "PATCH", {
        expectedVersion: group.version,
        name: nameInput.value.trim() || undefined,
        goal: goalInput.value.trim() || undefined,
        exclusiones: exclusionsInput.value.trim(),
        addDependencyCodes: dependencyCodes.length > 0 ? dependencyCodes : undefined,
      });
    });
    panel.append(refineForm);

    if (view.stories.length > 0) {
      panel.append(buildStoryEditor(view));
    }

    const criterionForm = createEl("form", { class: "edit-form" });
    criterionForm.append(createEl("h4", { text: "Nuevo criterio de aceptación" }));
    const criterionInput = createEl("textarea", { class: "form-textarea", rows: "2", attrs: { placeholder: "Condición observable y verificable", "aria-label": "Texto del criterio" } });
    const criterionSubmit = createEl("button", { class: "btn-secondary btn-sm", text: "Agregar criterio" });
    criterionForm.append(criterionInput, criterionSubmit);
    criterionForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = criterionInput.value.trim();
      if (text === "") {
        showToast("Escribí el criterio antes de guardarlo.", "error");
        return;
      }
      await submitEdit(`/api/groups/${group.id}/criteria`, "POST", { text });
    });
    panel.append(criterionForm);

    const decisionForm = createEl("form", { class: "edit-form" });
    decisionForm.append(createEl("h4", { text: "Registrar una decisión confirmada" }));
    const decisionTitle = createEl("input", { class: "form-input", attrs: { placeholder: "Título", "aria-label": "Título de la decisión" } });
    const decisionQuestion = createEl("input", { class: "form-input", attrs: { placeholder: "Pregunta", "aria-label": "Pregunta de la decisión" } });
    const decisionAnswer = createEl("textarea", { class: "form-textarea", rows: "2", attrs: { placeholder: "Respuesta confirmada por la persona", "aria-label": "Respuesta de la decisión" } });
    const decisionSubmit = createEl("button", { class: "btn-secondary btn-sm", text: "Registrar decisión" });
    decisionForm.append(decisionTitle, decisionQuestion, decisionAnswer, decisionSubmit);
    decisionForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!decisionTitle.value.trim() || !decisionQuestion.value.trim() || !decisionAnswer.value.trim()) {
        showToast("Completá título, pregunta y respuesta.", "error");
        return;
      }
      await submitEdit(`/api/groups/${group.id}/decisions`, "POST", {
        title: decisionTitle.value.trim(),
        question: decisionQuestion.value.trim(),
        answer: decisionAnswer.value.trim(),
      });
    });
    panel.append(decisionForm);

    panel.append(
      createEl("p", {
        class: "surface-sub edit-footnote",
        text: "No disponible en esta interfaz: reordenar grupos, mover historias entre grupos y fusionar épicas. Esas operaciones siguen en product-backlog/MCP.",
      })
    );

    return panel;
  }

  function buildStoryEditor(view) {
    const form = createEl("form", { class: "edit-form" });
    form.append(createEl("h4", { text: "Editar una historia" }));
    const select = createEl("select", { class: "form-select", attrs: { "aria-label": "Historia a editar" } });
    for (const story of view.stories) {
      const option = createEl("option", { text: `${story.code || "H???"} — ${story.title}` });
      option.value = story.id;
      select.append(option);
    }
    const titleInput = createEl("input", { class: "form-input", attrs: { placeholder: "Título", "aria-label": "Título de la historia" } });
    const descriptionInput = createEl("textarea", { class: "form-textarea", rows: "2", attrs: { placeholder: "Descripción", "aria-label": "Descripción de la historia" } });
    const statusSelect = createEl("select", { class: "form-select", attrs: { "aria-label": "Estado de la historia" } });
    for (const status of ["captured", "draft", "refined", "ready", "discarded"]) {
      const option = createEl("option", { text: status });
      option.value = status;
      statusSelect.append(option);
    }
    const prioritySelect = createEl("select", { class: "form-select", attrs: { "aria-label": "Prioridad de la historia" } });
    for (const priority of ["low", "medium", "high", "blocker"]) {
      const option = createEl("option", { text: priority });
      option.value = priority;
      prioritySelect.append(option);
    }
    const submit = createEl("button", { class: "btn-secondary btn-sm", text: "Guardar historia" });

    let current = view.stories[0];
    const fill = () => {
      current = view.stories.find((story) => story.id === select.value) ?? view.stories[0];
      titleInput.value = current.title ?? "";
      descriptionInput.value = current.description ?? "";
      statusSelect.value = current.status ?? "draft";
      prioritySelect.value = current.priority ?? "medium";
    };
    select.addEventListener("change", fill);
    fill();

    form.append(select, titleInput, descriptionInput, statusSelect, prioritySelect, submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await submitEdit(`/api/backlog/items/${current.id}`, "PATCH", {
        expectedVersion: current.version,
        title: titleInput.value.trim(),
        description: descriptionInput.value.trim(),
        status: statusSelect.value,
        priority: prioritySelect.value,
      });
    });
    return form;
  }

  async function submitEdit(endpoint, method, body) {
    try {
      await fetchAPI(endpoint, { method, body: JSON.stringify(body) });
      showToast("Cambio guardado.", "success");
      await loadGroups();
    } catch (error) {
      showToast(error?.message || "No se pudo guardar el cambio.", "error");
    }
  }

  let pendingConfirmation = null;

  function askHumanConfirmation({ title, message, expected, onConfirm }) {
    pendingConfirmation = { expected, onConfirm };
    const modal = document.getElementById("modalConfirm");
    const titleEl = document.getElementById("confirmTitle");
    const messageEl = document.getElementById("confirmMessage");
    const expectedEl = document.getElementById("confirmExpected");
    const input = document.getElementById("confirmPhraseInput");

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;
    if (expectedEl) expectedEl.textContent = expected;
    if (input) input.value = "";
    modal?.classList.add("open");
    input?.focus();
  }

  async function groupAction(groupId, action, body) {
    try {
      await fetchAPI(`/api/groups/${groupId}/${action}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      showToast("Acción registrada.", "success");
      await loadGroups();
    } catch {
      // fetchAPI already surfaced the error.
    }
  }

  function initGroupView() {
    const byGroup = document.getElementById("btnViewByGroup");
    const byEpic = document.getElementById("btnViewByEpic");
    const groupsList = document.getElementById("groupsList");
    const epicsList = document.getElementById("epicsList");

    const show = (which) => {
      const isGroup = which === "group";
      groupsList?.toggleAttribute("hidden", !isGroup);
      epicsList?.toggleAttribute("hidden", isGroup);
      byGroup?.classList.toggle("active", isGroup);
      byEpic?.classList.toggle("active", !isGroup);
      const detail = document.getElementById("groupDetail");
      detail?.toggleAttribute("hidden", !isGroup);
    };

    byGroup?.addEventListener("click", () => show("group"));
    byEpic?.addEventListener("click", () => show("epic"));
  }

  function initConfirmModal() {
    const button = document.getElementById("btnConfirmAction");
    const input = document.getElementById("confirmPhraseInput");
    button?.addEventListener("click", async () => {
      if (!pendingConfirmation) return;
      const typed = (input?.value ?? "").trim();
      if (typed !== pendingConfirmation.expected) {
        showToast(`Escribí exactamente: ${pendingConfirmation.expected}`, "error");
        return;
      }
      const action = pendingConfirmation;
      pendingConfirmation = null;
      document.getElementById("modalConfirm")?.classList.remove("open");
      await action.onConfirm(typed);
    });
  }

  // --- 2. Kanban Board ---
  async function loadKanban() {
    if (!state.currentProject) return;
    const filterQuery = state.activeSectionFilter ? `?sectionId=${state.activeSectionFilter}` : "";
    state.kanbanData = await fetchAPI(`/api/projects/${state.currentProject.id}/board${filterQuery}`);
    renderKanban();
  }

  function renderKanban() {
    const listTodo = document.getElementById("listTodo");
    const listInProgress = document.getElementById("listInProgress");
    const listDone = document.getElementById("listDone");

    if (!listTodo || !listInProgress || !listDone) return;

    listTodo.innerHTML = "";
    listInProgress.innerHTML = "";
    listDone.innerHTML = "";

    document.getElementById("countTodo").textContent = state.kanbanData.todo.length;
    document.getElementById("countInProgress").textContent = state.kanbanData.in_progress.length;
    document.getElementById("countDone").textContent = state.kanbanData.done.length;
    document.getElementById("archiveCountBadge").textContent = state.kanbanData.done.length;

    for (const t of state.kanbanData.todo) {
      listTodo.appendChild(createTaskCard(t, "todo"));
    }
    for (const t of state.kanbanData.in_progress) {
      listInProgress.appendChild(createTaskCard(t, "in_progress"));
    }
    for (const t of state.kanbanData.done) {
      listDone.appendChild(createTaskCard(t, "done"));
    }
  }

  function createTaskCard(task, columnStatus) {
    const card = createEl("div", { class: "task-card", dataset: { id: task.id } });
    const sectionColor = safeColor(task.section_color);

    const badges = createEl("div", { class: "card-badges" }, [
      createEl("span", { class: `badge badge-type-${task.type}`, text: task.type }),
      createEl("span", { class: `badge badge-priority-${task.priority}`, text: task.priority }),
      task.section_name
        ? createEl(
            "span",
            {
              class: "section-chip",
              style: {
                "font-size": "0.68rem",
                padding: "1px 6px",
                "border-color": `${sectionColor}44`,
              },
            },
            [
              createEl("span", {
                class: "section-dot",
                style: { "background-color": sectionColor },
              }),
              document.createTextNode(` ${task.section_name}`),
            ]
          )
        : null,
    ]);

    const timeBox = createEl("div");
    const actions = createEl("div", { class: "card-actions" });

    if (columnStatus === "todo") {
      const startButton = createEl("button", {
        class: "btn-primary btn-sm btn-start-task",
        dataset: { id: task.id },
        text: "▶ Iniciar",
      });
      startButton.addEventListener("click", async (e) => {
        e.stopPropagation();
        await fetchAPI(`/api/tasks/${task.id}/start`, { method: "POST" });
        showToast(`Tarea "${task.title}" iniciada`);
        loadKanban();
      });
      actions.append(startButton);
    } else if (columnStatus === "in_progress") {
      const completeButton = createEl("button", {
        class: "btn-primary btn-sm btn-complete-task",
        dataset: { id: task.id },
        text: "✓ Completar",
      });
      completeButton.addEventListener("click", (e) => {
        e.stopPropagation();
        openCompleteModal(task);
      });
      actions.append(completeButton);

      if (task.started_at) {
        const elapsedSecs = Math.max(
          0,
          Math.round((Date.now() - new Date(task.started_at).getTime()) / 1000)
        );
        timeBox.append(
          createEl("span", {
            class: "live-timer",
            dataset: { started: task.started_at },
            text: `⏱️ ${formatDuration(elapsedSecs)}`,
          })
        );
      }
    } else if (columnStatus === "done") {
      if (task.cycle_time_seconds) {
        timeBox.append(
          createEl("span", {
            style: { color: "var(--success)", "font-weight": "600" },
            text: `⚡ ${formatDuration(task.cycle_time_seconds)}`,
          })
        );
      }
    }

    const editButton = createEl("button", {
      class: "btn-secondary btn-sm btn-edit-task",
      dataset: { id: task.id },
      attrs: { title: "Editar" },
      text: "✏️",
    });
    editButton.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditTaskModal(task);
    });
    actions.append(editButton);

    card.append(
      createEl("div", { class: "card-top" }, [badges]),
      createEl("div", { class: "card-title", text: task.title }),
      task.description ? createEl("div", { class: "card-desc", text: task.description }) : null,
      createEl("div", { class: "card-footer" }, [timeBox, actions])
    );

    return card;
  }

  // --- Archival Flush ---
  function initArchiveButton() {
    const btn = document.getElementById("btnArchiveDone");
    btn?.addEventListener("click", async () => {
      if (!state.currentProject) return;
      if (state.kanbanData.done.length === 0) {
        showToast("No hay tareas completadas para archivar", "error");
        return;
      }

      const res = await fetchAPI(`/api/projects/${state.currentProject.id}/archive-done`, {
        method: "POST",
        body: JSON.stringify({ forceManual: true }),
      });

      showToast(`📦 ${res.archivedCount} tareas archivadas permanentemente`);
      loadKanban();
    });
  }

  // --- 2. Backlog ---
  async function loadBacklog() {
    if (!state.currentProject) return;
    const filterQuery = state.activeSectionFilter ? `?sectionId=${state.activeSectionFilter}` : "";
    state.backlogTasks = await fetchAPI(`/api/projects/${state.currentProject.id}/backlog${filterQuery}`);
    renderBacklog();
  }

  function renderBacklog() {
    const container = document.getElementById("backlogSectionsList");
    if (!container) return;

    container.innerHTML = "";

    const searchTerm = (document.getElementById("backlogSearchInput")?.value || "").toLowerCase();
    const filteredTasks = state.backlogTasks.filter((t) =>
      t.title.toLowerCase().includes(searchTerm) || (t.description && t.description.toLowerCase().includes(searchTerm))
    );

    if (filteredTasks.length === 0) {
      container.innerHTML = '<div class="empty-state">No hay tareas pendientes en el backlog.</div>';
      return;
    }

    // Group by section
    const grouped = new Map();
    for (const s of state.sections) {
      grouped.set(s.id, { section: s, tasks: [] });
    }
    grouped.set("unassigned", { section: { id: null, name: "Sin Sección", color: "#6e7681" }, tasks: [] });

    for (const t of filteredTasks) {
      const key = t.section_id && grouped.has(t.section_id) ? t.section_id : "unassigned";
      grouped.get(key).tasks.push(t);
    }

    for (const [_, group] of grouped.entries()) {
      if (group.tasks.length === 0) continue;

      const groupEl = document.createElement("div");
      groupEl.className = "backlog-section-group";

      groupEl.append(
        createEl("div", { class: "section-group-header" }, [
          createEl("div", { style: { display: "flex", "align-items": "center", gap: "8px" } }, [
            createEl("span", {
              class: "section-dot",
              style: { "background-color": safeColor(group.section.color) },
            }),
            createEl("span", { text: group.section.name }),
          ]),
          createEl("span", { class: "col-count", text: group.tasks.length }),
        ])
      );

      const rowsContainer = document.createElement("div");
      rowsContainer.className = "backlog-rows-container";
      groupEl.append(rowsContainer);

      for (const task of group.tasks) {
        const row = document.createElement("div");
        row.className = "backlog-row";

        const startButton = createEl("button", {
          class: "btn-primary btn-sm btn-start-row",
          dataset: { id: task.id },
          text: "▶ Iniciar",
        });
        startButton.addEventListener("click", async () => {
          await fetchAPI(`/api/tasks/${task.id}/start`, { method: "POST" });
          showToast(`Tarea iniciada: ${task.title}`);
          loadBacklog();
        });

        const editButton = createEl("button", {
          class: "btn-secondary btn-sm btn-edit-row",
          dataset: { id: task.id },
          text: "✏️",
        });
        editButton.addEventListener("click", () => {
          openEditTaskModal(task);
        });

        row.append(
          createEl("div", { class: "backlog-row-left" }, [
            createEl("span", {
              class: `badge badge-priority-${task.priority}`,
              text: task.priority,
            }),
            createEl("span", { class: `badge badge-type-${task.type}`, text: task.type }),
            createEl("span", { style: { "font-weight": "500" }, text: task.title }),
          ]),
          createEl("div", { style: { display: "flex", "align-items": "center", gap: "8px" } }, [
            startButton,
            editButton,
          ])
        );

        rowsContainer.appendChild(row);
      }

      container.appendChild(groupEl);
    }
  }

  // --- 3. History ---
  async function loadHistory(query = "") {
    if (!state.currentProject) return;
    const queryParam = query ? `?query=${encodeURIComponent(query)}` : `?page=${state.historyData.page}&limit=${state.historyData.limit}`;
    state.historyData = await fetchAPI(`/api/projects/${state.currentProject.id}/history${queryParam}`);
    renderHistory();
  }

  function renderHistory() {
    const tbody = document.getElementById("historyTableBody");
    const totalCountEl = document.getElementById("historyTotalCount");
    if (!tbody) return;

    if (totalCountEl) totalCountEl.textContent = state.historyData.total || 0;
    tbody.innerHTML = "";

    if (!state.historyData.items || state.historyData.items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No se encontraron registros en el historial.</td></tr>';
      return;
    }

    for (const item of state.historyData.items) {
      const tr = document.createElement("tr");
      const cycleText = item.cycle_time_seconds ? formatDuration(item.cycle_time_seconds) : "-";
      const sectionColor = safeColor(item.section_color);

      tr.append(
        createEl("td", {}, [
          createEl("span", { class: `badge badge-type-${item.type}`, text: item.type }),
        ]),
        createEl("td", {}, [
          createEl("span", { class: `badge badge-priority-${item.priority}`, text: item.priority }),
        ]),
        createEl("td", { style: { "font-weight": "600" }, text: item.title }),
        createEl("td", {}, [
          item.section_name
            ? createEl(
                "span",
                {
                  class: "section-chip",
                  style: { "font-size": "0.7rem", padding: "1px 6px" },
                },
                [
                  createEl("span", {
                    class: "section-dot",
                    style: { "background-color": sectionColor },
                  }),
                  document.createTextNode(` ${item.section_name}`),
                ]
              )
            : document.createTextNode("-"),
        ]),
        createEl("td", {
          style: { "font-family": "var(--font-mono)", color: "var(--primary-hover)" },
          text: cycleText,
        }),
        createEl("td", {
          style: {
            "max-width": "250px",
            "font-size": "0.8rem",
            color: "var(--text-muted)",
          },
          text: item.notes || "-",
        }),
        createEl("td", {
          style: { "font-size": "0.75rem", color: "var(--text-dim)" },
          text: formatDate(item.archived_at),
        })
      );
      tbody.appendChild(tr);
    }
  }

  // --- 4. Efficiency & Metrics ---
  async function loadMetrics() {
    if (!state.currentProject) return;
    state.metrics = await fetchAPI(`/api/projects/${state.currentProject.id}/metrics`);
    renderMetrics();
  }

  function renderMetrics() {
    if (!state.metrics) return;

    const windowDays = state.metrics.timeWindowDays ?? 30;
    const timelineTitle = document.getElementById("velocityTimelineTitle");
    if (timelineTitle) {
      timelineTitle.textContent = `Tendencia de Entregas (Últimos ${windowDays} días)`;
    }

    document.getElementById("kpiAvgCycle").textContent = state.metrics.formattedAvgCycleTime;
    document.getElementById("kpiAvgLead").textContent = state.metrics.formattedAvgLeadTime;
    document.getElementById("kpiBugfixVelocity").textContent = state.metrics.formattedBugfixVelocity;
    document.getElementById("kpiThroughputAll").textContent = state.metrics.throughput.allTime;
    document.getElementById("kpiTodayCount").textContent = state.metrics.throughput.today;
    document.getElementById("kpiWeekCount").textContent = state.metrics.throughput.thisWeek;

    // Distribution
    const distContainer = document.getElementById("distributionBars");
    if (distContainer) {
      distContainer.innerHTML = "";
      const dist = state.metrics.distribution;
      const total = Object.values(dist).reduce((a, b) => a + b, 0) || 1;

      const types = [
        { key: "feature", label: "Features", color: "var(--primary)" },
        { key: "bugfix", label: "Bugfixes", color: "var(--danger)" },
        { key: "chore", label: "Chores", color: "var(--text-muted)" },
        { key: "refactor", label: "Refactors", color: "var(--purple)" },
        { key: "debt", label: "Debt", color: "var(--warning)" },
      ];

      for (const t of types) {
        const count = dist[t.key] || 0;
        const pct = Math.round((count / total) * 100);
        const row = createEl("div", { class: "dist-bar-row" }, [
          createEl("div", { class: "dist-bar-label", text: t.label }),
          createEl("div", { class: "dist-bar-track" }, [
            createEl("div", {
              class: "dist-bar-fill",
              style: { width: `${pct}%`, "background-color": safeColor(t.color) },
            }),
          ]),
          createEl("div", { class: "dist-bar-count", text: count }),
        ]);
        distContainer.appendChild(row);
      }
    }

    // Timeline trends
    const timelineContainer = document.getElementById("velocityTimeline");
    if (timelineContainer) {
      timelineContainer.innerHTML = "";
      if (state.metrics.dailyTrends.length === 0) {
        timelineContainer.innerHTML = '<div class="empty-state" style="padding: 10px;">Sin entregas en el período solicitado.</div>';
      } else {
        for (const item of state.metrics.dailyTrends) {
          const row = createEl("div", { class: "trend-day-row" }, [
            createEl("span", { text: item.date }),
            createEl("strong", {
              style: { color: "var(--success)", "font-family": "var(--font-mono)" },
              text: `+${item.completedCount} completadas`,
            }),
          ]);
          timelineContainer.appendChild(row);
        }
      }
    }
  }

  // --- 5. Projects Manager ---
  function renderProjectsManager() {
    const grid = document.getElementById("projectsGrid");
    if (!grid) return;

    grid.innerHTML = "";
    for (const p of state.projects) {
      const card = createEl("div", {
        class: `project-card ${state.currentProject?.id === p.id ? "active" : ""}`,
      });
      card.append(
        createEl("div", { class: "project-card-title", text: p.name }),
        createEl("div", {
          class: "project-card-desc",
          text: p.description || "Sin descripción",
        }),
        createEl("div", { class: "project-card-stats" }, [
          createEl("span", {}, ["Activas: ", createEl("strong", { text: p.active_tasks_count || 0 })]),
          createEl("span", {}, ["Por Hacer: ", createEl("strong", { text: p.todo_count || 0 })]),
          createEl("span", {}, ["Completadas: ", createEl("strong", { text: p.done_count || 0 })]),
        ])
      );

      card.addEventListener("click", () => {
        state.currentProject = p;
        renderProjectSelector();
        renderProjectsManager();
        loadProjectSections();
      });

      grid.appendChild(card);
    }
  }

  // --- Modals Management ---
  function initModals() {
    document.querySelectorAll("[data-close-modal]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const modalId = btn.getAttribute("data-close-modal");
        const modal = document.getElementById(modalId);
        modal?.classList.remove("open");
      });
    });

    // Close on backdrop click
    document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) {
          backdrop.classList.remove("open");
        }
      });
    });

    // Open Task Modal Button
    document.getElementById("btnOpenNewTask")?.addEventListener("click", () => {
      document.getElementById("formTask")?.reset();
      document.getElementById("taskIdField").value = "";
      document.getElementById("modalTaskTitle").textContent = "Nueva Tarea";
      document.getElementById("modalTask")?.classList.add("open");
    });

    // Open Project Modal Button
    document.getElementById("btnNewProject")?.addEventListener("click", () => {
      document.getElementById("formProject")?.reset();
      document.getElementById("modalProject")?.classList.add("open");
    });
    document.getElementById("btnCreateProjectModal")?.addEventListener("click", () => {
      document.getElementById("formProject")?.reset();
      document.getElementById("modalProject")?.classList.add("open");
    });

    // Open Section Modal Button
    document.getElementById("btnNewSection")?.addEventListener("click", () => {
      document.getElementById("formSection")?.reset();
      document.getElementById("modalSection")?.classList.add("open");
    });

    // Submit Task Form
    document.getElementById("formTask")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const taskId = document.getElementById("taskIdField").value;
      const title = document.getElementById("taskTitleInput").value;
      const type = document.getElementById("taskTypeSelect").value;
      const priority = document.getElementById("taskPrioritySelect").value;
      const sectionId = document.getElementById("taskSectionSelect").value || null;
      const storyPoints = document.getElementById("taskStoryPointsInput").value ? parseInt(document.getElementById("taskStoryPointsInput").value, 10) : null;
      const description = document.getElementById("taskDescriptionInput").value || null;

      if (taskId) {
        // Edit task
        await fetchAPI(`/api/tasks/${taskId}`, {
          method: "PATCH",
          body: JSON.stringify({ title, type, priority, section_id: sectionId, story_points: storyPoints, description }),
        });
        showToast("Tarea actualizada exitosamente");
      } else {
        // Create task
        await fetchAPI(`/api/projects/${state.currentProject.id}/tasks`, {
          method: "POST",
          body: JSON.stringify({ title, type, priority, sectionId, storyPoints, description }),
        });
        showToast("Tarea creada en el backlog");
      }

      document.getElementById("modalTask")?.classList.remove("open");
      loadActiveTabData();
    });

    // Submit Complete Task Form
    document.getElementById("formCompleteTask")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const taskId = document.getElementById("completeTaskIdField").value;
      const notes = document.getElementById("completeTaskNotesInput").value;

      await fetchAPI(`/api/tasks/${taskId}/complete`, {
        method: "POST",
        body: JSON.stringify({ notes }),
      });

      showToast("Tarea marcada como completada");
      document.getElementById("modalCompleteTask")?.classList.remove("open");
      loadKanban();
    });

    // Submit New Section Form
    document.getElementById("formSection")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("sectionNameInput").value;
      const color = document.getElementById("sectionColorInput").value;

      await fetchAPI(`/api/projects/${state.currentProject.id}/sections`, {
        method: "POST",
        body: JSON.stringify({ name, color }),
      });

      showToast(`Sección "${name}" creada`);
      document.getElementById("modalSection")?.classList.remove("open");
      await loadProjectSections();
      if (state.activeTab === "backlog") loadBacklog();
    });

    // Submit New Project Form
    document.getElementById("formProject")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("projectNameInput").value;
      const description = document.getElementById("projectDescInput").value;
      const rootPath = document.getElementById("projectPathInput").value;
      const archiveThresholdHours = parseInt(document.getElementById("projectThresholdInput").value, 10) || 24;

      const created = await fetchAPI("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name, description, rootPath, archiveThresholdHours }),
      });

      showToast(`Proyecto "${created.name}" registrado`);
      document.getElementById("modalProject")?.classList.remove("open");
      state.currentProject = created;
      await loadProjects();
    });
  }

  function openCompleteModal(task) {
    document.getElementById("completeTaskIdField").value = task.id;
    document.getElementById("completeTaskTitleNotice").textContent = `Completando: "${task.title}"`;
    document.getElementById("completeTaskNotesInput").value = task.notes || "";
    document.getElementById("modalCompleteTask")?.classList.add("open");
  }

  function openEditTaskModal(task) {
    document.getElementById("taskIdField").value = task.id;
    document.getElementById("modalTaskTitle").textContent = "Editar Tarea";
    document.getElementById("taskTitleInput").value = task.title;
    document.getElementById("taskTypeSelect").value = task.type;
    document.getElementById("taskPrioritySelect").value = task.priority;
    document.getElementById("taskSectionSelect").value = task.section_id || "";
    document.getElementById("taskStoryPointsInput").value = task.story_points || "";
    document.getElementById("taskDescriptionInput").value = task.description || "";
    document.getElementById("modalTask")?.classList.add("open");
  }

  // --- Search Listeners ---
  function initSearchInputs() {
    const backlogSearch = document.getElementById("backlogSearchInput");
    backlogSearch?.addEventListener("input", () => {
      renderBacklog();
    });

    const historySearch = document.getElementById("historySearchInput");
    historySearch?.addEventListener("input", (e) => {
      clearTimeout(state.searchDebounceTimer);
      state.searchDebounceTimer = setTimeout(() => {
        loadHistory(e.target.value);
      }, 300);
    });

    const projectSelect = document.getElementById("projectSelect");
    projectSelect?.addEventListener("change", (e) => {
      const selected = state.projects.find((p) => p.id === e.target.value);
      if (selected) {
        state.currentProject = selected;
        renderProjectSelector();
        loadProjectSections();
        loadActiveTabData();
      }
    });
  }

  // --- Live Timer for in_progress cards ---
  function initLiveTimers() {
    setInterval(() => {
      const timers = document.querySelectorAll(".live-timer");
      timers.forEach((el) => {
        const started = el.getAttribute("data-started");
        if (started) {
          const diff = Math.max(0, Math.round((Date.now() - new Date(started).getTime()) / 1000));
          el.textContent = `⏱️ ${formatDuration(diff)}`;
        }
      });
    }, 1000);
  }

  // --- Bootstrap ---
  window.addEventListener("DOMContentLoaded", async () => {
    initTheme();
    initTabs();
    initModals();
    initArchiveButton();
    initSearchInputs();
    initIdeaCapture();
    initGroupView();
    initOverviewMap();
    initConfirmModal();
    initLiveTimers();
    await loadProjects();
  });
