// RequireFlow Vanilla Client Application
import { createEl, safeColor } from "./safe-dom.js";

const state = {
  projects: [],
  currentProject: null,
  sections: [],
  activeTab: "kanban",
  activeSectionFilter: null,
  kanbanData: { todo: [], in_progress: [], done: [] },
  backlogTasks: [],
  historyData: { items: [], total: 0, page: 1, limit: 20 },
  metrics: null,
  searchDebounceTimer: null,
};

  // --- API Client ---
  async function fetchAPI(endpoint, options = {}) {
    try {
      const res = await fetch(endpoint, {
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });

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
      // Auto-detect or initialize current project
      const current = await fetchAPI("/api/projects/current");
      state.projects = [current];
      state.currentProject = current;
    } else if (!state.currentProject) {
      state.currentProject = state.projects[0];
    }

    renderProjectSelector();
    await loadProjectSections();
    await loadActiveTabData();
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
  function initTabs() {
    const navItems = document.querySelectorAll(".sidebar-nav .nav-item");
    navItems.forEach((btn) => {
      btn.addEventListener("click", () => {
        navItems.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");

        const tab = btn.getAttribute("data-tab");
        state.activeTab = tab;

        document.querySelectorAll(".view-panel").forEach((panel) => {
          panel.classList.remove("active");
        });

        const targetPanel = document.getElementById(`view${capitalize(tab)}`);
        targetPanel?.classList.add("active");

        const titles = {
          kanban: "Tablero Kanban",
          backlog: "Backlog & Secciones",
          history: "Historial Permanente",
          metrics: "Eficiencia & Métricas",
          projects: "Gestor de Proyectos",
        };
        const titleEl = document.getElementById("currentTabTitle");
        if (titleEl) titleEl.textContent = titles[tab] || "RequireFlow";

        // Section filter only makes sense in kanban & backlog
        const filterBar = document.getElementById("sectionFilterBar");
        if (filterBar) {
          filterBar.style.display = (tab === "kanban" || tab === "backlog") ? "flex" : "none";
        }

        loadActiveTabData();
      });
    });
  }

  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  async function loadActiveTabData() {
    if (!state.currentProject) return;

    switch (state.activeTab) {
      case "kanban":
        await loadKanban();
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

  // --- 1. Kanban Board ---
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
        timelineContainer.innerHTML = '<div class="empty-state" style="padding: 10px;">Sin entregas en los últimos 7 días.</div>';
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
    initLiveTimers();
    await loadProjects();
  });
