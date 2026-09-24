import { getDatabase } from "./connection.ts";
import { createProject } from "../domain/project.ts";
import { createSection, listSections } from "../domain/section.ts";
import { createTask, startTask, completeTask } from "../domain/task.ts";
import { archiveDoneTasks } from "../domain/archive.ts";

export function seedDemoData() {
  const db = getDatabase();

  console.log("🌱 Sembrando datos de prueba para RequireFlow...");

  // 1. Crear proyecto demo
  const projectName = "SaaS E-Commerce Platform";
  const existingProject = db.query("SELECT * FROM projects WHERE name = ?").get(projectName) as any;
  
  if (existingProject) {
    db.run("DELETE FROM projects WHERE id = ?", [existingProject.id]);
    console.log(`Proyecto existente "${projectName}" eliminado para regenerar datos limpios.`);
  }

  const project = createProject(
    {
      name: projectName,
      description: "Plataforma de comercio electrónico con pagos en Stripe, catálogo y recomendaciones",
      rootPath: "C:/proyectos/saas-ecommerce",
      archiveThresholdHours: 24,
    },
    db
  );

  console.log(`✓ Proyecto creado: ${project.name} (ID: ${project.id})`);

  // 2. Secciones personalizadas
  const sections = listSections(project.id, db);
  const generalSec = sections.find((s) => s.name === "General");
  const frontendSec = sections.find((s) => s.name === "Frontend");
  const backendSec = sections.find((s) => s.name === "Backend");
  const bugfixSec = sections.find((s) => s.name === "Bugfixes");

  const databaseSec = createSection(
    { projectId: project.id, name: "Database & Cache", color: "#f59e0b" },
    db
  );
  const securitySec = createSection(
    { projectId: project.id, name: "Security & Auth", color: "#ec4899" },
    db
  );

  console.log("✓ Secciones temáticas configuradas.");

  // 3. Tareas en Por Hacer (To Do)
  createTask(
    {
      projectId: project.id,
      sectionId: bugfixSec?.id,
      title: "Error 500 al procesar pago con tarjetas 3D Secure en Stripe",
      description: "Los webhooks de confirmación fallan intermitentemente cuando el banco solicita validación OTP.",
      type: "bugfix",
      priority: "blocker",
      storyPoints: 5,
    },
    db
  );

  createTask(
    {
      projectId: project.id,
      sectionId: securitySec.id,
      title: "Implementar autenticación social con Google y GitHub OAuth",
      description: "Permitir a los usuarios iniciar sesión en un solo clic con token JWT y refresh token.",
      type: "feature",
      priority: "high",
      storyPoints: 5,
    },
    db
  );

  createTask(
    {
      projectId: project.id,
      sectionId: frontendSec?.id,
      title: "Añadir filtros interactivos por precio, categoría y rating",
      description: "Diseñar sidebar colapsable con sliders reactivos y búsqueda instantánea en frontend.",
      type: "feature",
      priority: "medium",
      storyPoints: 3,
    },
    db
  );

  createTask(
    {
      projectId: project.id,
      sectionId: databaseSec.id,
      title: "Configurar caché Redis para consultas frecuentes de catálogo",
      description: "Reducir la carga de la base de datos principal cacheando productos destacados con TTL de 1 hora.",
      type: "chore",
      priority: "medium",
      storyPoints: 2,
    },
    db
  );

  createTask(
    {
      projectId: project.id,
      sectionId: generalSec?.id,
      title: "Actualizar Bun a v1.3.14 y auditoría de dependencias",
      description: "Revisar avisos de seguridad en paquetes npm y actualizar types.",
      type: "chore",
      priority: "low",
      storyPoints: 1,
    },
    db
  );

  console.log("✓ Tareas creadas en 'Por Hacer'.");

  // 4. Tareas En Progreso (In Progress)
  const taskProg1 = createTask(
    {
      projectId: project.id,
      sectionId: backendSec?.id,
      title: "Servicio de notificaciones en tiempo real vía WebSockets",
      description: "Notificar al comprador cuando el paquete cambie de estado a 'En camino'.",
      type: "feature",
      priority: "high",
      storyPoints: 8,
    },
    db
  );
  startTask(taskProg1.id, db);
  // Simular que arrancó hace 45 minutos
  const started45m = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  db.run("UPDATE tasks SET started_at = ? WHERE id = ?", [started45m, taskProg1.id]);

  const taskProg2 = createTask(
    {
      projectId: project.id,
      sectionId: databaseSec.id,
      title: "Optimizar subconsulta N+1 en lista de pedidos del usuario",
      description: "Hacer eager loading de líneas de pedido y productos relacionados.",
      type: "refactor",
      priority: "medium",
      storyPoints: 3,
    },
    db
  );
  startTask(taskProg2.id, db);
  // Simular que arrancó hace 18 minutos
  const started18m = new Date(Date.now() - 18 * 60 * 1000).toISOString();
  db.run("UPDATE tasks SET started_at = ? WHERE id = ?", [started18m, taskProg2.id]);

  console.log("✓ Tareas configuradas en 'En Progreso'.");

  // 5. Tareas Completadas Recientes (Done - listas para archivar)
  const taskDone1 = createTask(
    {
      projectId: project.id,
      sectionId: securitySec.id,
      title: "Solucionar problema de CORS en headers de preflight OPTIONS",
      type: "bugfix",
      priority: "high",
      storyPoints: 2,
    },
    db
  );
  const startedDone1 = new Date(Date.now() - 25 * 60 * 1000).toISOString();
  const completedDone1 = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  db.run(
    `UPDATE tasks SET status = 'done', started_at = ?, completed_at = ?, cycle_time_seconds = 1200, notes = ? WHERE id = ?`,
    [startedDone1, completedDone1, "Agregados headers Access-Control-Allow-Origin y métodos en el router HTTP", taskDone1.id]
  );

  const taskDone2 = createTask(
    {
      projectId: project.id,
      sectionId: frontendSec?.id,
      title: "Diseñar componente responsive para la barra de navegación",
      type: "feature",
      priority: "medium",
      storyPoints: 3,
    },
    db
  );
  const startedDone2 = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const completedDone2 = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  db.run(
    `UPDATE tasks SET status = 'done', started_at = ?, completed_at = ?, cycle_time_seconds = 2700, notes = ? WHERE id = ?`,
    [startedDone2, completedDone2, "Navbar con soporte móvil, menú hamburguesa y badge de carrito", taskDone2.id]
  );

  console.log("✓ Tareas agregadas a 'Completadas Recientes'.");

  // 6. Tareas Archivadas en el Historial Permanente (para tener métricas y FTS5 poblado)
  const historicalItems = [
    {
      title: "Configurar pipeline de CI/CD en GitHub Actions",
      type: "chore",
      priority: "high",
      notes: "Tests automatizados con bun test y verificación de tipos con tsc en cada PR.",
      cycleMinutes: 32,
      daysAgo: 5,
    },
    {
      title: "Migración inicial de base de datos a SQLite WAL",
      type: "feature",
      priority: "blocker",
      notes: "Creadas tablas con claves foráneas activadas y tabla virtual de búsqueda FTS5.",
      cycleMinutes: 48,
      daysAgo: 4,
    },
    {
      title: "Fuga de memoria en listener de conexiones WebSockets",
      type: "bugfix",
      priority: "high",
      notes: "Eliminado listener duplicado en el evento disconnect del cliente.",
      cycleMinutes: 22,
      daysAgo: 3,
    },
    {
      title: "Diseño del modal de checkout y resumen de compra",
      type: "feature",
      priority: "medium",
      notes: "Componente Vanilla con validación de tarjeta y feedback visual inmediato.",
      cycleMinutes: 40,
      daysAgo: 2,
    },
    {
      title: "Optimizar compresión de imágenes WebP en el bucket S3",
      type: "refactor",
      priority: "low",
      notes: "Reducción del 65% en el peso de las imágenes del catálogo.",
      cycleMinutes: 15,
      daysAgo: 1,
    },
  ];

  for (const h of historicalItems) {
    const t = createTask(
      {
        projectId: project.id,
        sectionId: generalSec?.id,
        title: h.title,
        type: h.type as any,
        priority: h.priority as any,
      },
      db
    );

    const startedDate = new Date(Date.now() - (h.daysAgo * 86400 + h.cycleMinutes * 60) * 1000).toISOString();
    const completedDate = new Date(Date.now() - h.daysAgo * 86400 * 1000).toISOString();
    const cycleSecs = h.cycleMinutes * 60;

    db.run(
      `UPDATE tasks SET status = 'done', started_at = ?, completed_at = ?, cycle_time_seconds = ?, notes = ? WHERE id = ?`,
      [startedDate, completedDate, cycleSecs, h.notes, t.id]
    );
  }

  // Archivar las históricas
  archiveDoneTasks(project.id, true, 0, db);

  // Volver a poner las dos tareas recientes en 'done' para que la columna no esté vacía
  db.run("UPDATE tasks SET status = 'done', archived_at = NULL WHERE id IN (?, ?)", [taskDone1.id, taskDone2.id]);
  db.run("DELETE FROM history WHERE task_id IN (?, ?)", [taskDone1.id, taskDone2.id]);

  console.log("✓ Historial permanente poblado con 5 tareas archivadas y métricas listas.");
  console.log("🎉 Datos de prueba sembrados exitosamente.");
}

if (import.meta.main) {
  seedDemoData();
}
