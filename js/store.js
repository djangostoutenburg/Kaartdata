/* Eenvoudige opslag in de browser (localStorage).
 * Datamodel:
 *   projects: [{ id, name, client, description, color, createdAt }]
 *   features: [{ id, projectId, geometry, shape, radius?, props: { name, kind, category, status, ref, notes, color } }]
 */
(function (global) {
  const KEY = 'kaartdata.v1';

  const uid = () =>
    (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (Array.isArray(data.projects) && Array.isArray(data.features)) return data;
      }
    } catch (e) {
      console.warn('Kon opgeslagen gegevens niet lezen', e);
    }
    return { projects: [], features: [], activeProjectId: null, view: null, baseLayer: null };
  }

  const state = load();

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.error('Opslaan mislukt', e);
      return false;
    }
  }

  const Store = {
    state,
    save,
    uid,

    projects() { return state.projects; },
    project(id) { return state.projects.find(p => p.id === id); },
    activeProject() { return this.project(state.activeProjectId); },
    setActive(id) { state.activeProjectId = id; save(); },

    addProject(data) {
      const p = { id: uid(), createdAt: new Date().toISOString(), color: '#2563eb', ...data };
      state.projects.push(p);
      state.activeProjectId = p.id;
      save();
      return p;
    },
    updateProject(id, data) {
      const p = this.project(id);
      if (p) Object.assign(p, data);
      save();
      return p;
    },
    deleteProject(id) {
      state.projects = state.projects.filter(p => p.id !== id);
      state.features = state.features.filter(f => f.projectId !== id);
      if (state.activeProjectId === id) state.activeProjectId = state.projects[0]?.id ?? null;
      save();
    },

    features(projectId) { return state.features.filter(f => f.projectId === projectId); },
    feature(id) { return state.features.find(f => f.id === id); },
    addFeature(f) {
      const feat = { id: uid(), ...f };
      state.features.push(feat);
      save();
      return feat;
    },
    updateFeature(id, data) {
      const f = this.feature(id);
      if (f) Object.assign(f, data);
      save();
      return f;
    },
    deleteFeature(id) {
      state.features = state.features.filter(f => f.id !== id);
      save();
    },
  };

  global.Store = Store;
})(window);
