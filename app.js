import { doc, setDoc, collection, onSnapshot, addDoc, updateDoc, deleteDoc, query, orderBy } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { getAuth, deleteUser } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { db } from "./firebase.js";

/* ============================================================
   Alignt HRMS — dashboard logic
   ============================================================ */

const session = getSession();
if (!session){
  window.location.href = "index.html";
  throw new Error("No session — redirecting to sign in.");
}

const CURRENT_USER = {
  name: session.name && session.name !== "Employee" ? session.name : deriveNameFromEmail(session.email),
  empId: session.empId && session.empId !== "AU-00000" ? session.empId : "AU-Pending",
  role: session.role || "employee",
  title: session.role === "admin" ? "HR Administrator" : "Employee",
  email: session.email,
  phone: "",
  address: "",
  department: "—",
  manager: "—",
  joined: "—",
  createdAt: session.createdAt || Date.now(),
  status: "absent",
  initials: initialsOf(session.name && session.name !== "Employee" ? session.name : deriveNameFromEmail(session.email)),
  avatarData: null,
  coverData: null
};

/* ---------------------------------------------------------
   Local Reactive Store
   --------------------------------------------------------- */
let EMPLOYEES = [];
let PAYROLL_SELF = [{ label: "Basic Pay", amount: 30000, deduction: false }];
let leaves = [];
const ADMIN_NET = {};

let punched = false;
let isFirstLoad = true;
let isFirstLeaveLoad = true;

const notiSound = new Audio("noti.mp3");

/* ---------------------------------------------------------
   Small helpers
   --------------------------------------------------------- */
const rupee = n => "₹" + Math.abs(n).toLocaleString("en-IN");

function notifyEvent(type, title, message){
  notiSound.play().catch(e => console.warn("Audio play prevented (User must interact with page first)", e));
  
  if (typeof Notify !== "undefined"){
    Notify.notify({ type, title, message });
  } else {
    toast(message);
  }
}

function getAvatarColor(name) {
  const colors = ['#1F6F5C', '#3FA796', '#F2A93B', '#D9534F', '#6C7FD8', '#8A5B10'];
  let hash = 0;
  for (let i = 0; i < (name || "A").length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function timeAgo(ts) {
    const diff = Math.max(0, Date.now() - ts);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

// Universal Image Compressor
const compressImage = (file, maxDim = 256) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
        const img = new Image();
        img.src = event.target.result;
        img.onload = () => {
            const canvas = document.createElement("canvas");
            let { width, height } = img;
            
            if (width > height) {
                if (width > maxDim) { height *= maxDim / width; width = maxDim; }
            } else {
                if (height > maxDim) { width *= maxDim / height; height = maxDim; }
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL("image/jpeg", 0.7)); 
        };
        img.onerror = reject;
    };
    reader.onerror = reject;
});

/* ---------------------------------------------------------
   App shell / routing
   --------------------------------------------------------- */
let dashBadge = null;
let currentView = "dashboard";

function initApp(role){
  // 1. Read the current view from the URL (default to dashboard if blank)
  const urlParams = new URLSearchParams(window.location.search);
  const initialView = urlParams.get('view') || "dashboard";

  // Setup Back Button Navigation
  window.history.replaceState({ view: initialView }, "", "?view=" + initialView);
  window.addEventListener("popstate", (e) => {
      if (e.state && e.state.view) {
          switchView(e.state.view, false);
      } else {
          if (confirm("Are you sure you want to log out and leave the dashboard?")) {
              logout();
          } else {
              window.history.pushState({ view: currentView }, "", "?view=" + currentView);
          }
      }
  });

  if (typeof Notify !== "undefined"){
    Notify.init({ position: "top-right", defaultDuration: 4200 });
    Notify.mountBell("#notif-bell-slot");
  }

  $("#topbar-username").textContent = CURRENT_USER.name;
  $("#topbar-role").textContent = role === "admin" ? "HR / Admin" : "Employee";
  document.body.classList.toggle("role-admin", role === "admin");

  $("#today-date").textContent = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });

  let badgeReady = { flip(){}, destroy(){} };
  try {
    badgeReady = createBadge($("#dash-badge-canvas"));
  } catch (err) {
    console.warn("Badge visual unavailable:", err);
  }
  dashBadge = badgeReady;
  const punchBtn = $("#dash-punch-btn");
  if (punchBtn) punchBtn.addEventListener("click", handlePunch);

  $$(".nav-item[data-view]").forEach(btn => {
    btn.addEventListener("click", () => {
        if (btn.dataset.view === "profile") {
            renderProfileView(CURRENT_USER);
        }
        switchView(btn.dataset.view);
    });
  });
  
  $("#logout-btn").addEventListener("click", logout);
  $("#hamburger").addEventListener("click", () => $(".sidebar").classList.toggle("is-open"));

  setupRealtimeListeners(role);
  renderQuickCards(role);
  initProfileEdit(); 
  initLeave(); 

  // Digital Presence Detection
  const userRef = doc(db, "users", CURRENT_USER.email);
  const setOnline = () => updateDoc(userRef, { isOnline: true, lastActive: Date.now() }).catch(e => console.warn(e));
  const setOffline = () => updateDoc(userRef, { isOnline: false }).catch(e => console.warn(e));

  setOnline();

  document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
          setOffline();
      } else {
          setOnline();
      }
  });

  setInterval(() => {
      if (document.visibilityState === "visible") setOnline();
  }, 30000);

  window.addEventListener("pagehide", setOffline);

  // 2. Load the view we found in the URL instead of defaulting to dashboard
  switchView(initialView, false);
}

function switchView(view, pushHistory = true){
  currentView = view;
  $$(".nav-item[data-view]").forEach(b => b.classList.toggle("is-active", b.dataset.view === view));
  $(".sidebar").classList.remove("is-open");

  const titles = {
    dashboard: "Dashboard", profile: "Profile", attendance: "Attendance",
    leave: "Leave", payroll: "Payroll", employees: "Employees", approvals: "Approvals",
    "admin-chats": "Global Chat Audit" // <--- Add this line
  };

  $("#view-title").textContent = titles[view] || view;

  $$(".view").forEach(sec => {
    if (sec.dataset.view === view){
      sec.classList.add("is-active");
      anime({ targets: sec, opacity: [0, 1], translateY: [10, 0], duration: 320, easing: "easeOutQuad" });
    } else {
      sec.classList.remove("is-active");
    }
  });
  
  if (pushHistory) {
      window.history.pushState({ view: view }, "", "?view=" + view);
  }

  if (view === "profile") renderProfileView(CURRENT_USER);
  if (view === "approvals" && CURRENT_USER.role === "admin") renderAdminLeaves();
  if (view === "leave") renderEmployeeLeaves();
  if (view === "employees" && CURRENT_USER.role === "admin") initEmployees();
  if (view === "attendance") initAttendance(CURRENT_USER.role);
  if (view === "payroll") initPayroll(CURRENT_USER.role);
  if (view === "dashboard" && CURRENT_USER.role === "admin") renderAdminSummary();
}

function logout(){
  clearSession();
  window.location.href = "index.html";
}

/* ---------------------------------------------------------
   Real-Time Data Handlers (Firestore)
   --------------------------------------------------------- */
function setupRealtimeListeners(role) {
  // 1. Employee Profiles & Ghost Account Cleaner
  onSnapshot(collection(db, "users"), (snapshot) => {
      let docsData = snapshot.docs.map(docSnap => ({ id: docSnap.id, email: docSnap.id, ...docSnap.data() }));
      
      docsData.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

      EMPLOYEES = docsData.map((data, index) => {
          const correctEmpId = "AU-" + String(index + 1).padStart(5, '0');
          let needsPatch = false;
          const patch = {};

          // DESTROY AU-00000 and generic "Employee" names!
          if (data.empId !== correctEmpId || data.empId === "AU-00000") {
              patch.empId = correctEmpId;
              needsPatch = true;
          }
          if (!data.name || data.name === "Employee") {
              patch.name = deriveNameFromEmail(data.email);
              needsPatch = true;
          }
          if (!data.joined) {
              patch.joined = new Date(data.createdAt || Date.now()).toLocaleDateString("en-IN", { day: 'numeric', month: 'short', year: 'numeric' });
              needsPatch = true;
          }
          if (!data.createdAt) {
              patch.createdAt = Date.now();
              needsPatch = true;
          }
          if (!data.role) {
              patch.role = "employee";
              needsPatch = true;
          }
          
          if (needsPatch) {
              updateDoc(doc(db, "users", data.id), patch).catch(e => console.warn(e));
              Object.assign(data, patch); 
          }

          // Generate today's date string (YYYY-MM-DD)
          const todayStr = new Date().toLocaleDateString("en-CA");
          const attendanceMap = data.attendance || {};
          const realTodayStatus = attendanceMap[todayStr] || "absent";

          if (data.id === CURRENT_USER.email) {
              const prevStatus = CURRENT_USER.status;
              
              CURRENT_USER.name = data.name;
              CURRENT_USER.phone = data.phone || "";
              CURRENT_USER.address = data.address || "";
              CURRENT_USER.joined = data.joined;
              CURRENT_USER.createdAt = data.createdAt;
              CURRENT_USER.department = data.department || "—";
              CURRENT_USER.avatarData = data.avatarData || null;
              CURRENT_USER.coverData = data.coverData || null;
              CURRENT_USER.empId = data.empId;
              
              // Apply the attendance map and check if they punched in TODAY
              CURRENT_USER.attendance = attendanceMap;
              CURRENT_USER.status = realTodayStatus;
              CURRENT_USER.role = data.role; 

              $("#topbar-username").textContent = CURRENT_USER.name;
              updateTopbarAvatar(); 

              punched = (CURRENT_USER.status === "present");
              const punchBtn = $("#dash-punch-btn");
              if (punchBtn) {
                  punchBtn.textContent = punched ? "Punch out" : "Punch in";
                  $("#stat-status").textContent = punched ? "In" : "Out";
              }
              
              if (isFirstLoad) {
                  if (punched && dashBadge && typeof dashBadge.flip === 'function') dashBadge.flip(); 
                  isFirstLoad = false;
              }

              // FIX: Correctly check the current view and ensure we aren't in edit mode before re-rendering
              if (currentView === "profile" && document.getElementById("profile-name-main")?.textContent === CURRENT_USER.name) {
                  const saveBtn = document.getElementById("save-profile-btn");
                  if (!saveBtn || saveBtn.hidden) {
                      renderProfileView(CURRENT_USER);
                  }
              }

              if (prevStatus !== CURRENT_USER.status && currentView === "attendance") renderCalendar();
          }
          
          // Return the true status for today so Admin tables are accurate!
          return { ...data, status: realTodayStatus, attendance: attendanceMap };
      });

      EMPLOYEES.sort((a,b) => (a.name || "").localeCompare(b.name || ""));
      renderAdminSidebar();
      if (role === "admin") {
          if (currentView === "dashboard") renderAdminSummary();
          if (currentView === "employees") initEmployees();
          if (currentView === "attendance") initAttendance(role);
      }
  });

  // 2. Global Leave System with SMART Notifications
  onSnapshot(collection(db, "leaves"), (snapshot) => {
      
      snapshot.docChanges().forEach(change => {
          if (!isFirstLeaveLoad) {
              const data = change.doc.data();
              
              if (role === "admin" && change.type === "added" && data.status === "pending") {
                  notifyEvent("info", "New Leave Request", `${data.who} applied for ${data.type}`);
              }
              
              if (role !== "admin" && change.type === "modified" && data.email === CURRENT_USER.email) {
                  if (data.status === "approved") notifyEvent("success", "Leave Approved", `Your ${data.type} request was approved!`);
                  if (data.status === "rejected") notifyEvent("danger", "Leave Rejected", `Your ${data.type} request was denied.`);
              }
          }
      });
      isFirstLeaveLoad = false;

      leaves = snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
          .sort((a, b) => b.createdAt - a.createdAt);

      if (currentView === "leave") renderEmployeeLeaves();
      if (role === "admin") {
          if (currentView === "approvals" || currentView === "leave") renderAdminLeaves();
          if (currentView === "dashboard") renderAdminSummary();
      }
  });

  // 3. Centralized Payroll System 
  onSnapshot(collection(db, "payroll"), (snapshot) => {
      snapshot.docs.forEach(docSnap => {
          const data = docSnap.data();
          ADMIN_NET[docSnap.id] = data.netPay;
          
          if (docSnap.id === CURRENT_USER.email) {
              PAYROLL_SELF = data.components || [
                  { label: "Basic Pay", amount: data.netPay || 30000, deduction: false }
              ];
          }
      });
      
      if (currentView === "payroll") {
          if (role === "admin" && !document.activeElement.closest("#admin-payroll-table")) renderAdminPayroll();
          if (!document.activeElement.closest("#admin-payroll-table")) initPayroll(role);
      }
  });
  }
      
      if (currentView === "payroll") {
          if (role === "admin" && !document.activeElement.closest("#admin-payroll-table")) renderAdminPayroll();
          if (!document.activeElement.closest("#admin-payroll-table")) initPayroll(role);
      };

  // 4. Live Activity Logs
  onSnapshot(collection(db, "activity_logs"), (snapshot) => {
      const allLogs = snapshot.docs.map(docSnap => docSnap.data()).sort((a, b) => b.ts - a.ts);
      const visibleLogs = role === "admin" ? allLogs : allLogs.filter(l => l.email === CURRENT_USER.email);
      renderActivity(visibleLogs, role);
  });


/* ---------------------------------------------------------
   Activity Feed Actions
   --------------------------------------------------------- */
async function logActivity(action) {
    try {
        await addDoc(collection(db, "activity_logs"), {
            action,
            name: CURRENT_USER.name,
            email: CURRENT_USER.email,
            ts: Date.now()
        });
    } catch(err) {
        console.error("Activity log error:", err);
    }
}

function renderActivity(logs, role) {
  const list = $("#activity-list");
  list.innerHTML = "";
  if (!logs || logs.length === 0) {
    list.innerHTML = `<li><span class="muted">No recent activity.</span></li>`;
    return;
  }
  
  logs.slice(0, 10).forEach(log => {
    const text = role === "admin" ? `<b>${log.name}</b> ${log.action.toLowerCase()}` : log.action;
    const li = document.createElement("li");
    li.innerHTML = `<span class="a-dot"></span><span style="flex:1">${text}</span><time>${timeAgo(log.ts)}</time>`;
    list.appendChild(li);
  });
}

/* ---------------------------------------------------------
   Punch in/out (dashboard)
   --------------------------------------------------------- */
/* ---------------------------------------------------------
   Punch in/out (dashboard)
   --------------------------------------------------------- */
async function handlePunch(){
  const newStatus = punched ? "punched_out" : "present";
  const todayStr = new Date().toLocaleDateString("en-CA");
  
  try {
      // Properly nest the map so Firestore merges it correctly inside 'attendance'
      await setDoc(doc(db, "users", CURRENT_USER.email), { 
          status: newStatus,
          attendance: {
              [todayStr]: newStatus 
          }
      }, { merge: true });
      
      await logActivity(newStatus === "present" ? "Punched in" : "Punched out for the day");
      
      dashBadge.flip();

      if (newStatus === "present"){
        notifyEvent("success", "Punched in", "Timer started for today.");
      } else {
        notifyEvent("info", "Punched out", `Logged out for today.`);
      }
  } catch (err) {
      console.error("Failed to sync attendance status", err);
  }
}

/* ---------------------------------------------------------
   Dashboard: quick cards + admin summary
   --------------------------------------------------------- */
function renderQuickCards(role){
  const cards = [
    { view: "profile", title: "Profile", desc: "View & edit your details", icon: profileIcon() },
    { view: "attendance", title: "Attendance", desc: "Check today's record", icon: calendarIcon() },
    { view: "leave", title: "Leave requests", desc: "Apply or track status", icon: checkIcon() },
    { view: "payroll", title: "Payroll", desc: "View salary structure", icon: coinIcon() }
  ];
  const wrap = $("#quick-cards");
  wrap.innerHTML = "";
  cards.forEach(c => {
    const btn = document.createElement("button");
    btn.className = "quick-card";
    btn.innerHTML = `${c.icon}<b>${c.title}</b><span>${c.desc}</span>`;
    btn.addEventListener("click", () => switchView(c.view));
    wrap.appendChild(btn);
  });
  anime({ targets: "#quick-cards .quick-card", opacity: [0, 1], translateY: [10, 0], delay: anime.stagger(60), duration: 380, easing: "easeOutQuad" });
}

function profileIcon(){ return `<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c1.4-4 4-6 7.5-6s6.1 2 7.5 6"/></svg>`; }
function calendarIcon(){ return `<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="16" rx="2"/><path d="M3.5 9.5h17"/><path d="M8 3v3M16 3v3"/></svg>`; }
function checkIcon(){ return `<svg viewBox="0 0 24 24"><path d="M4 12.5l4.5 4.5L20 6"/></svg>`; }
function coinIcon(){ return `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9M9 9.5h4.2a1.8 1.8 0 0 1 0 3.6H10a1.8 1.8 0 0 0 0 3.6H15"/></svg>`; }

function renderAdminSummary(){
  const pendingCount = leaves.filter(l => l.status === "pending").length;
  
  const employeeList = EMPLOYEES; // Removed filter
  const presentCount = employeeList.filter(e => e.status === "present" || e.status === "punched_out").length;
  
  $("#admin-summary").innerHTML = `
    <div class="panel"><span class="muted">Team size (Employees)</span><span class="big">${employeeList.length}</span></div>
    <div class="panel"><span class="muted">Online / Present</span><span class="big">${presentCount}/${employeeList.length}</span></div>
    <div class="panel"><span class="muted">Pending approvals</span><span class="big">${pendingCount}</span></div>
  `;
}

/* ---------------------------------------------------------
   Profile & Strict Avatar/Cover Constraints
   --------------------------------------------------------- */
function updateTopbarAvatar() {
    const topbarAvatar = $("#topbar-avatar");
    if (!topbarAvatar) return;

    topbarAvatar.style.overflow = 'hidden'; 

    if (CURRENT_USER.avatarData) {
        topbarAvatar.innerHTML = `<img src="${CURRENT_USER.avatarData}" style="width:34px; height:34px; max-width:34px; max-height:34px; min-width:34px; min-height:34px; object-fit:cover; display:block; border-radius:50%; margin:0; padding:0;">`;
        topbarAvatar.style.backgroundColor = 'transparent';
    } else {
        topbarAvatar.innerHTML = "";
        topbarAvatar.textContent = initialsOf(CURRENT_USER.name);
        topbarAvatar.style.backgroundColor = getAvatarColor(CURRENT_USER.name);
    }
}

function renderProfileView(userObj) {
  const isSelf = userObj.email === CURRENT_USER.email;

  $("#profile-name-main").textContent = userObj.name;
  const displayTitle = userObj.title || (userObj.role === 'admin' ? 'HR Administrator' : 'Employee');
  $("#profile-role-line").textContent = `${displayTitle} · ${userObj.department || '—'}`;
  $("#profile-location-text").textContent = userObj.address || "Not added yet";

  const giantAvatar = $("#profile-avatar");
  if (giantAvatar) {
      giantAvatar.style.overflow = "hidden";
      if (userObj.avatarData) {
          giantAvatar.innerHTML = `<img src="${userObj.avatarData}" style="width:112px; height:112px; max-width:112px; max-height:112px; min-width:112px; min-height:112px; object-fit:cover; display:block; border-radius:50%; border:none; margin:0; padding:0;">`;
          giantAvatar.style.backgroundColor = 'transparent';
          giantAvatar.style.border = 'none';
      } else {
          giantAvatar.innerHTML = "";
          giantAvatar.textContent = initialsOf(userObj.name);
          giantAvatar.style.backgroundColor = getAvatarColor(userObj.name);
          giantAvatar.style.border = "4px solid var(--card)";
      }
  }

  const coverEl = $(".profile-cover");
  if (coverEl) {
      if (userObj.coverData) {
          coverEl.style.background = `url(${userObj.coverData}) center/cover`;
      } else {
          coverEl.style.background = `linear-gradient(120deg, var(--brand-dark), var(--brand))`;
      }
  }

  // Rebuilt grid using readonly inputs that can be toggled
  const grid = $("#profile-view-grid");
  grid.innerHTML = `
    <div class="p-field"><b>Full name</b><input type="text" id="inline-edit-name" class="inline-input editable" value="${userObj.name}" readonly></div>
    <div class="p-field"><b>Work email</b><input type="email" id="inline-edit-email" class="inline-input editable" value="${userObj.email}" readonly></div>
    <div class="p-field"><b>Phone number</b><input type="tel" id="inline-edit-phone" class="inline-input editable" value="${userObj.phone || ""}" placeholder="Not added yet" readonly></div>
    <div class="p-field"><b>Address</b><input type="text" id="inline-edit-address" class="inline-input editable" value="${userObj.address || ""}" placeholder="Not added yet" readonly></div>
    <div class="p-field"><b>Employee ID</b><input type="text" class="inline-input" value="${userObj.empId}" readonly></div>
    <div class="p-field"><b>Joined on</b><input type="text" class="inline-input" value="${userObj.joined || "—"}" readonly></div>
  `;

  window.editingEmail = userObj.email; 

  const actionsDiv = $("#profile-actions");
  const editBtn = $("#edit-profile-btn");
  const promoteBtn = $("#promote-admin-btn");
  const deleteBtn = $("#delete-account-btn");

  if (isSelf) {
      // Viewing your own profile: You CAN edit and delete your own account
      actionsDiv.style.display = "flex";
      editBtn.style.display = "inline-block";
      if (promoteBtn) promoteBtn.style.display = "none";
      
      if (deleteBtn) {
          deleteBtn.style.display = "inline-block";
          deleteBtn.textContent = "Delete My Account";
          deleteBtn.onclick = async () => handleAccountDeletion(userObj, true);
      }
  } else if (CURRENT_USER.role === "admin") {
      // Admin viewing someone else's profile
      actionsDiv.style.display = "flex";
      editBtn.style.display = "none"; // <-- Disabled editing for other profiles
      
      if (deleteBtn) {
          deleteBtn.style.display = "none"; // <-- Completely removes the delete option for admins
      }
      
      if (promoteBtn) {
          if (userObj.role !== "admin") {
              promoteBtn.style.display = "inline-block";
              
              promoteBtn.onclick = async () => {
                  if (!confirm(`Are you sure you want to promote ${userObj.name} to HR/Admin?`)) return;
                  
                  promoteBtn.disabled = true;
                  promoteBtn.textContent = "Promoting...";
                  
                  try {
                      await updateDoc(doc(db, "users", userObj.email), { role: "admin" });
                      await logActivity(`Promoted ${userObj.name} to HR/Admin`);
                      notifyEvent("success", "Role Updated", `${userObj.name} is now an HR/Admin.`);
                      
                      userObj.role = "admin";
                      renderProfileView(userObj); 
                  } catch (err) {
                      console.error("Promotion error:", err);
                      notifyEvent("danger", "Action Failed", "Could not promote the user.");
                  } finally {
                      promoteBtn.disabled = false;
                      promoteBtn.textContent = "Promote to HR/Admin";
                  }
              };
          } else {
              promoteBtn.style.display = "none";
          }
      }
  } else {
      // Standard employee viewing someone else's profile
      actionsDiv.style.display = "none";
  }
}

function initProfileEdit(){
  const editBtn = $("#edit-profile-btn");
  const saveBtn = $("#save-profile-btn");
  const cancelBtn = $("#cancel-profile-btn");
  const coverBtn = $("#cover-camera-btn");
  const avatarWrap = $("#profile-avatar-wrapper");
  
  const avatarInput = $("#hidden-avatar-input");
  const coverInput = $("#hidden-cover-input");

  let isEditing = false;
  let tempAvatarData = null;
  let tempCoverData = null;

  function toggleEditMode(state) {
    isEditing = state;
    editBtn.hidden = state;
    saveBtn.hidden = !state;
    cancelBtn.hidden = !state;
    coverBtn.hidden = !state;
    
    avatarWrap.classList.toggle("is-editing", state);
    
    // Toggle readonly attribute on editable fields
    $$(".inline-input.editable").forEach(input => {
      if (state) {
        input.removeAttribute("readonly");
      } else {
        input.setAttribute("readonly", "true");
      }
    });

    if (state) $("#inline-edit-name").focus();
  }

  if (editBtn.dataset.bound) return;

  editBtn.addEventListener("click", () => toggleEditMode(true));
  
  cancelBtn.addEventListener("click", () => {
    toggleEditMode(false);
    tempAvatarData = null;
    tempCoverData = null;
    renderProfileView(CURRENT_USER); // Re-render to clear unsaved changes
  });

  // Image file explorer triggers
  coverBtn.addEventListener("click", () => coverInput.click());
  avatarWrap.addEventListener("click", () => { if (isEditing) avatarInput.click(); });

  // Handle live previews for selected images
  avatarInput.addEventListener("change", async (e) => {
      if (e.target.files && e.target.files[0]) {
          tempAvatarData = await compressImage(e.target.files[0], 256);
          const giantAvatar = $("#profile-avatar");
          giantAvatar.innerHTML = `<img src="${tempAvatarData}" style="width:112px; height:112px; object-fit:cover; border-radius:50%; border:none;">`;
          giantAvatar.style.background = 'transparent';
      }
  });

  coverInput.addEventListener("change", async (e) => {
      if (e.target.files && e.target.files[0]) {
          tempCoverData = await compressImage(e.target.files[0], 1024);
          $(".profile-cover").style.background = `url(${tempCoverData}) center/cover`;
      }
  });

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    const newName = $("#inline-edit-name").value;
    const newEmail = $("#inline-edit-email").value;
    const newPhone = $("#inline-edit-phone").value;
    const newAddress = $("#inline-edit-address").value;

    try {
      let updatedData = {
        name: newName,
        email: newEmail, 
        phone: newPhone,
        address: newAddress
      };

      if (tempAvatarData) updatedData.avatarData = tempAvatarData;
      if (tempCoverData) updatedData.coverData = tempCoverData;

      // 1. Save to whichever profile we are currently editing
      await setDoc(doc(db, "users", window.editingEmail), updatedData, { merge: true });

      // 2. Only update the local session cookie if the user is editing their OWN profile
      if (window.editingEmail === CURRENT_USER.email) {
          const session = getSession();
          session.name = newName;
          setSession(session);
      }
      
      toggleEditMode(false);
      notifyEvent("success", "Profile updated", "The profile changes were permanently saved.");
    } catch (error) {
      console.error("Firebase update failed: ", error);
      notifyEvent("danger", "Update failed", "Could not save the details.");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Changes";
    }
  });

  editBtn.dataset.bound = "true";
}

/* ---------------------------------------------------------
   Attendance
   --------------------------------------------------------- */
function initAttendance(role){
  const monthLabel = new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  $("#att-month-label").textContent = monthLabel;
  renderCalendar();

  $$("#att-view-toggle button").forEach(btn => {
    btn.addEventListener("click", () => {
      $$("#att-view-toggle button").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      renderCalendar(btn.dataset.range);
    });
  });

  if (role === "admin"){
    const table = $("#admin-attendance-table");
    const employeeList = EMPLOYEES; // Removed filter
    
    table.innerHTML = `
      <tr><th>Employee</th><th>ID</th><th>Department</th><th>Status</th></tr>
      ${employeeList.length === 0 ? `<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--muted)">No employee data available.</td></tr>` : 
      employeeList.map(e => {
        const displayStatus = e.status === 'punched_out' ? 'present' : e.status;
        return `
        <tr>
          <td>${e.name}</td><td>${e.empId}</td><td>${e.department || '—'}</td>
          <td><span class="status-pill ${displayStatus}">${label(displayStatus)}</span></td>
        </tr>`
      }).join("")}
    `;
  }
  }  {
    $("#admin-attendance-panel")?.remove();
  }

function label(status){
  return { present: "Present", half: "Half-day", absent: "Absent", leave: "Leave", weekend: "Weekend" }[status] || status;
}

function renderCalendar(range = "month"){
  const grid = $("#cal-grid");
  grid.innerHTML = "";
  const dows = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  dows.forEach(d => {
    const el = document.createElement("div");
    el.className = "cal-dow";
    el.textContent = d;
    grid.appendChild(el);
  });

  const now = new Date();
  let daysToShow = [];

  if (range === "week"){
    const start = new Date(now);
    start.setDate(now.getDate() - now.getDay());
    for (let i = 0; i < 7; i++){
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      daysToShow.push(d);
    }
    const startDow = daysToShow[0].getDay();
    for (let i = 0; i < startDow; i++) grid.appendChild(emptyCell());
  } else {
    const year = now.getFullYear(), month = now.getMonth();
    const firstDay = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let i = 0; i < firstDay.getDay(); i++) grid.appendChild(emptyCell());
    for (let d = 1; d <= daysInMonth; d++) daysToShow.push(new Date(year, month, d));
  }

  daysToShow.forEach(d => {
    const cell = document.createElement("div");
    const cellTime = d.getTime();
    
    const joinDate = new Date(CURRENT_USER.createdAt);
    const joinStart = new Date(joinDate.getFullYear(), joinDate.getMonth(), joinDate.getDate()).getTime();
    
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const isFuture = cellTime > todayStart;
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    
    const dateStr = d.toLocaleDateString("en-CA");
    let status = "";
    
    if (cellTime < joinStart) {
        status = ""; 
    } else if (isFuture) {
        status = ""; 
    } else if (isWeekend) {
        status = "weekend"; 
    } else {
        // Look up the specific day in the user's saved history
        const dayRecord = CURRENT_USER.attendance ? CURRENT_USER.attendance[dateStr] : null;
        status = (dayRecord === "present" || dayRecord === "punched_out") ? "present" : "absent";
    }

    cell.className = "cal-cell" + (status ? ` ${status}` : "");
    cell.textContent = d.getDate();
    grid.appendChild(cell);
  });

  anime({ targets: "#cal-grid .cal-cell", opacity: [0, 1], scale: [0.8, 1], delay: anime.stagger(10), duration: 320, easing: "easeOutQuad" });
}

function emptyCell(){
  const el = document.createElement("div");
  el.className = "cal-cell empty";
  return el;
}

/* ---------------------------------------------------------
   Leave Submissions
   --------------------------------------------------------- */
function initLeave(){
  const leaveForm = $("#leave-form");
  if (!leaveForm || leaveForm.dataset.bound) return;
  
  leaveForm.addEventListener("submit", async e => {
    e.preventDefault(); 
    
    const from = $("#leave-from").value;
    const to = $("#leave-to").value;
    const leaveType = $("#leave-type").value;
    
    if (!from || !to){ toast("Pick a start and end date."); return; }

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";

    try {
        await addDoc(collection(db, "leaves"), {
          who: CURRENT_USER.name,
          email: CURRENT_USER.email,
          type: leaveType,
          from, to,
          remarks: $("#leave-remarks").value,
          status: "pending",
          createdAt: Date.now()
        });
        
        await logActivity(`Applied for ${leaveType.toLowerCase()}`);
        
        e.target.reset();
        notifyEvent("info", "Leave request submitted", `${leaveType} · awaiting approval.`);
    } catch (err) {
        console.error("Leave Submission Error:", err);
        notifyEvent("danger", "Submission failed", "Unable to log the request at this time.");
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit request";
    }
  });
  
  leaveForm.dataset.bound = "true";
}

function fmtRange(from, to){
  const opts = { day: "numeric", month: "short" };
  const f = new Date(from).toLocaleDateString("en-IN", opts);
  const t = new Date(to).toLocaleDateString("en-IN", opts);
  return f === t ? f : `${f} – ${t}`;
}

function renderEmployeeLeaves(){
  const mine = leaves.filter(l => l.email === CURRENT_USER.email);
  const list = $("#leave-list-employee");
  list.innerHTML = "";
  if (!mine.length){
    list.innerHTML = `<li class="leave-card"><span class="muted">No leave requests yet.</span></li>`;
    return;
  }
  mine.forEach(l => {
    const li = document.createElement("li");
    li.className = "leave-card";
    li.innerHTML = `
      <div class="row1"><b>${l.type}</b><span class="status-pill ${l.status}">${cap(l.status)}</span></div>
      <span class="dates">${fmtRange(l.from, l.to)}</span>
      ${l.remarks ? `<span class="remarks">${l.remarks}</span>` : ""}
    `;
    list.appendChild(li);
  });
}

function renderAdminLeaves(){
  const list = $("#leave-list-admin");
  if (!list) return;
  list.innerHTML = "";
  
  const pending = leaves.filter(l => l.status === "pending");
  if (!pending.length){
    list.innerHTML = `<li class="leave-card"><span class="muted">No pending requests. All caught up.</span></li>`;
    return;
  }
  pending.forEach(l => {
    const li = document.createElement("li");
    li.className = "leave-card";
    li.dataset.id = l.id;
    li.innerHTML = `
      <div class="row1"><span class="who">${l.who}</span><span class="status-pill pending">Pending</span></div>
      <b>${l.type}</b>
      <span class="dates">${fmtRange(l.from, l.to)}</span>
      ${l.remarks ? `<span class="remarks">${l.remarks}</span>` : ""}
      <div class="leave-actions">
        <button class="approve" data-act="approved">Approve</button>
        <button class="reject" data-act="rejected">Reject</button>
      </div>
    `;
    list.appendChild(li);
  });

  $$("#leave-list-admin .leave-actions button").forEach(btn => {
    btn.addEventListener("click", () => resolveLeave(btn));
  });
}

function resolveLeave(btn){
  const li = btn.closest("li");
  const id = li.dataset.id;
  const action = btn.dataset.act;

  anime({
    targets: li,
    opacity: 0,
    translateX: action === "approved" ? 30 : -30,
    duration: 260,
    easing: "easeInQuad",
    complete: async () => {
      try {
          const rec = leaves.find(l => l.id === id);
          await updateDoc(doc(db, "leaves", id), { status: action });
          await logActivity(`${action === "approved" ? "Approved" : "Rejected"} leave for ${rec ? rec.who : 'employee'}`);
          notifyEvent(
             action === "approved" ? "success" : "danger",
             `Leave ${action}`,
             rec ? `${rec.who} · ${rec.type} · ${fmtRange(rec.from, rec.to)}` : `Request ${action}.`
          );
      } catch (err) {
          console.error("Resolve error:", err);
          notifyEvent("danger", "Failed to resolve", "Could not complete the leave action.");
          anime({ targets: li, opacity: 1, translateX: 0, duration: 200 });
      }
    }
  });
}

function cap(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

/* ---------------------------------------------------------
   Payroll
   --------------------------------------------------------- */
function initPayroll(role){
  const net = PAYROLL_SELF.reduce((sum, r) => sum + (r.deduction ? -r.amount : r.amount), 0);
  const table = $("#payroll-table-employee");
  
  table.innerHTML = `
    <tr><th>Component</th><th style="text-align:right">Amount</th></tr>
    ${PAYROLL_SELF.length === 0 ? `<tr><td colspan="2" style="text-align:center; padding:20px; color:var(--muted)">No payroll data available.</td></tr>` :
    PAYROLL_SELF.map(r => `
      <tr>
        <td>${r.label}</td>
        <td style="text-align:right; ${r.deduction ? "color:#B23B36" : ""}">${r.deduction ? "−" : ""}${rupee(r.amount)}</td>
      </tr>`).join("")}
    <tr><td><b>Net pay</b></td><td style="text-align:right"><b>${rupee(net)}</b></td></tr>
  `;

  if (role === "admin"){
    renderAdminPayroll();
  } else {
    $("#admin-payroll-panel")?.remove();
  }
}

function renderAdminPayroll(){
  const table = $("#admin-payroll-table");
  const empList = EMPLOYEES; // Removed filter
  
  table.innerHTML = `
    <tr><th>Employee</th><th>ID</th><th>Net pay</th><th></th></tr>
    ${empList.length === 0 ? `<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--muted)">No employee data available.</td></tr>` : 
    empList.map(e => `
      <tr data-id="${e.email}">
        <td>${e.name}</td><td>${e.empId}</td>
        <td><input class="editable-input" type="number" value="${ADMIN_NET[e.email] ?? 30000}"></td>
        <td><button class="save-row-btn">Save</button></td>
      </tr>`).join("")}
  `;
  
  $$("#admin-payroll-table .save-row-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const row = btn.closest("tr");
      const email = row.dataset.id;
      const val = row.querySelector(".editable-input").value;
      
      btn.disabled = true;
      btn.textContent = "Saving...";

      try {
          await setDoc(doc(db, "payroll", email), {
              netPay: Number(val),
              updatedAt: Date.now()
          }, { merge: true });
          
          anime({ targets: row, backgroundColor: ["#DCF1EC", "transparent"], duration: 900, easing: "easeOutQuad" });
          notifyEvent("success", "Salary updated", `New net pay saved for ${email}.`);
      } catch (err) {
          console.error("Payroll save error:", err);
          notifyEvent("danger", "Update failed", "Could not save the new net pay amount.");
      } finally {
          btn.disabled = false;
          btn.textContent = "Save";
      }
    });
  });
}

/* ---------------------------------------------------------
   Employees (admin) - HR Directory w/ Profiles
   --------------------------------------------------------- */
function initEmployees(){
  const table = $("#employees-table");
  if (!table) return;
  
  const empList = EMPLOYEES; // Removed filter
  
  table.innerHTML = `
    <tr><th>Employee</th><th>ID</th><th>Department</th><th>Today</th></tr>
    ${empList.length === 0 ? `<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--muted)">No employee data available.</td></tr>` : 
    empList.map(e => {
      const displayStatus = e.status === 'punched_out' ? 'present' : e.status;
      
      // Restored avatar logic
      const avatarHTML = e.avatarData 
        ? `<img src="${e.avatarData}" style="width:28px;height:28px;max-width:28px;max-height:28px;min-width:28px;min-height:28px;border-radius:50%;object-fit:cover;display:block;">`
        : `<div style="width:28px;height:28px;border-radius:50%;background:${getAvatarColor(e.name)};color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:bold;">${initialsOf(e.name)}</div>`;

      return `
      <tr class="emp-row" data-email="${e.email}" style="cursor:pointer; transition: background 0.15s;">
        <td style="display:flex;align-items:center;gap:10px;">
           ${avatarHTML}
           <span style="font-weight: 500; flex: 1;">${e.name}</span>
<button class="msg-icon-btn" onclick="event.stopPropagation(); window.openChatWith('${e.empId}')">             <svg viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
           </button>
        </td>
        <td>${e.empId}</td>
        <td>${e.department || '—'}</td>
        <td><span class="status-pill ${displayStatus}">${label(displayStatus)}</span></td>
      </tr>`;
    }).join("")}
  `;

  $$(".emp-row").forEach(row => {
      row.addEventListener("mouseover", () => row.style.backgroundColor = "var(--paper-2)");
      row.addEventListener("mouseout", () => row.style.backgroundColor = "transparent");
      
      row.addEventListener("click", () => {
          const email = row.dataset.email;
          const targetEmployee = EMPLOYEES.find(e => e.email === email);
          if (targetEmployee) {
              renderProfileView(targetEmployee);
              switchView("profile");
          }
      });
  });
}

function renderAdminSidebar() {
    const onlineList = $("#admin-online-list");
    const offlineList = $("#admin-offline-list");
    const onlineCount = $("#admin-online-count");
    const offlineCount = $("#admin-offline-count");
    
    if (!onlineList || !offlineList) return;
    
    onlineList.innerHTML = "";
    offlineList.innerHTML = "";

    // Filter only for HR/Admins
    const admins = EMPLOYEES.filter(e => e.role === "admin");
    
    // Split into Online and Offline arrays using the 60-second heartbeat check
    const now = Date.now();
    const onlineAdmins = admins.filter(a => a.isOnline && (now - (a.lastActive || 0) < 60000));
    const offlineAdmins = admins.filter(a => !a.isOnline || (now - (a.lastActive || 0) >= 60000));

    if (onlineCount) onlineCount.textContent = onlineAdmins.length;
    if (offlineCount) offlineCount.textContent = offlineAdmins.length;

    const createCard = (admin, isOnline) => {
        const avatar = admin.avatarData 
          ? `<img src="${admin.avatarData}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;display:block;">`
          : `<div style="width:32px;height:32px;border-radius:50%;background:${getAvatarColor(admin.name)};color:#fff;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:600;">${initialsOf(admin.name)}</div>`;

        // Only generate the live red dot if the user's tab is currently open
        const dotHTML = isOnline ? `<div class="live-dot"></div>` : '';

        const card = document.createElement("div");
        card.className = "discord-member";
        card.innerHTML = `
            <div style="position: relative; display: flex;">
                ${avatar}
                ${dotHTML}
            </div>
            <span class="member-name">${admin.name}</span>
        `;
        
        card.addEventListener("click", () => {
            renderProfileView(admin);
            switchView("profile");
        });
        return card;
    };

    // Render cards to their respective divisions
    onlineAdmins.forEach(admin => onlineList.appendChild(createCard(admin, true)));
    offlineAdmins.forEach(admin => offlineList.appendChild(createCard(admin, false)));
}

async function handleAccountDeletion(targetUser, isSelf) {
    const confirmMsg = isSelf 
        ? "Are you absolutely sure you want to permanently delete your account?"
        : `Are you sure you want to wipe all data for ${targetUser.name}?`;
        
    if (!confirm(confirmMsg)) return;

    try {
        // Step 1: Always delete the Firestore Document
        await deleteDoc(doc(db, "users", targetUser.email));
        
        if (isSelf) {
            // Step 2: If self-deleting, delete the Auth credentials
            const auth = getAuth();
            if (auth.currentUser) {
                await deleteUser(auth.currentUser);
            }
            clearSession();
            window.location.href = "index.html";
        } else {
            // Admin deleting someone else
            await logActivity(`Deleted user data for ${targetUser.email}`);
            notifyEvent("success", "User Removed", "Their profile and data has been completely wiped.");
            switchView("employees"); // Kick admin back to directory
        }
    } catch (err) {
        console.error("Deletion error:", err);
        if (err.code === 'auth/requires-recent-login') {
            alert("For security reasons, you must log out and log back in before deleting your account.");
        } else {
            notifyEvent("danger", "Failed to delete", "An error occurred while deleting the data.");
        }
    }
}
/* ---------------------------------------------------------
   Boot
   --------------------------------------------------------- */
initApp(session.role);

/* ---------------------------------------------------------
   Internal Messaging System
   --------------------------------------------------------- */
let chatUnsubscribe = null;
let currentChatEmpId = null;
let currentChatTab = "short"; // Tracks which inbox we are looking at
let allMessages = [];
let lastMsgSoundTime = 0; 
let isFirstMessageLoad = true; 

function getMiniAvatar(emp) {
    if (!emp) return '';
    return emp.avatarData 
      ? `<img src="${emp.avatarData}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;display:block;">`
      : `<div style="width:32px;height:32px;border-radius:50%;background:${getAvatarColor(emp.name)};color:#fff;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:600;">${initialsOf(emp.name)}</div>`;
}

// Global Tab Click Listener
document.addEventListener("click", (e) => {
    if (e.target.classList.contains("chat-tab")) {
        document.querySelectorAll(".chat-tab").forEach(t => {
            t.style.borderBottomColor = "transparent";
            t.style.color = "var(--muted)";
        });
        e.target.style.borderBottomColor = "var(--brand)";
        e.target.style.color = "var(--brand)";
        
        currentChatTab = e.target.dataset.tab;
        
        // Reset the main view when switching inboxes
        currentChatEmpId = null;
        if ($("#chat-active-state")) $("#chat-active-state").style.display = "none";
        if ($("#chat-empty-state")) $("#chat-empty-state").style.display = "flex";
        if ($("#chat-formal-composer")) $("#chat-formal-composer").style.display = "none";
        if ($("#chat-search-wrap")) $("#chat-search-wrap").hidden = false;
        
        renderChatSidebar();
    }
});

onSnapshot(query(collection(db, "messages"), orderBy("ts", "asc")), (snapshot) => {
    allMessages = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    let unreadCount = 0;
    let playSound = false;

    snapshot.docChanges().forEach(change => {
        if (change.type === "added" && !isFirstMessageLoad) {
            const msg = change.doc.data();
            if (msg.receiver === CURRENT_USER.empId && (currentView !== "messages" || currentChatEmpId !== msg.sender)) {
                playSound = true;
            }
        }
    });
    isFirstMessageLoad = false;

    allMessages.forEach(msg => {
        if (msg.receiver === CURRENT_USER.empId && !msg.read) {
            const msgType = msg.type || "short";
            if (currentView === "messages" && currentChatEmpId === msg.sender && currentChatTab === msgType) {
                updateDoc(doc(db, "messages", msg.id), { read: true }).catch(e => console.warn(e));
            } else {
                unreadCount++;
            }
        }
    });

    const badge = $("#nav-msg-badge");
    if (badge) {
        badge.textContent = unreadCount > 99 ? "99+" : unreadCount;
        badge.hidden = unreadCount === 0;
    }

    if (playSound && Date.now() - lastMsgSoundTime > 10000) {
        lastMsgSoundTime = Date.now();
        notiSound.play().catch(e => console.warn(e));
        if (typeof Notify !== "undefined") Notify.toast("New message received", { type: "info" });
    }

    renderChatSidebar();
    if (currentChatEmpId) renderChatHistory(currentChatEmpId);
    if (CURRENT_USER.role === "admin") renderAdminGlobalChats();
});

function renderChatSidebar() {
    const list = $("#chat-convo-list");
    if (!list) return;
    list.innerHTML = "";
    
    const convoMap = new Map();
    
    allMessages.forEach(msg => {
        const msgType = msg.type || "short";
        if (msgType !== currentChatTab) return; // Strict separation for chat history!

        if (msg.sender === CURRENT_USER.empId || msg.receiver === CURRENT_USER.empId || msg.cc === CURRENT_USER.empId) {
            let otherId = msg.sender === CURRENT_USER.empId ? msg.receiver : msg.sender;
            if (msg.cc === CURRENT_USER.empId && msg.sender !== CURRENT_USER.empId) otherId = msg.sender;
            
            convoMap.set(otherId, msg); 
        }
    });

    const sortedConvos = Array.from(convoMap.entries()).sort((a, b) => b[1].ts - a[1].ts);
    
    sortedConvos.forEach(([otherId, latestMsg]) => {
        const targetEmp = EMPLOYEES.find(e => e.empId === otherId);
        if (!targetEmp) return;

        const div = document.createElement("div");
        div.className = `chat-convo ${currentChatEmpId === otherId ? "is-active" : ""}`;
        
        let preview = latestMsg.text || "📎 Attached File";
        if (latestMsg.type === "formal" && latestMsg.subject) preview = "Subject: " + latestMsg.subject;
        if (latestMsg.sender === CURRENT_USER.empId) preview = "You: " + preview;

        const isUnread = latestMsg.receiver === CURRENT_USER.empId && !latestMsg.read;
        if (isUnread) div.style.borderLeft = "4px solid var(--absent)";

        div.innerHTML = `
            ${getMiniAvatar(targetEmp)}
            <div class="chat-convo-info">
               <div class="chat-convo-name" style="${isUnread ? 'font-weight:700;' : ''}">${targetEmp.name}</div>
               <div class="chat-convo-preview" style="${isUnread ? 'color:var(--ink); font-weight:600;' : ''}">${preview}</div>
            </div>
        `;
        // FIX 1: Explicitly target the window object to prevent ReferenceErrors
        div.onclick = () => window.openChatWith(otherId);
        list.appendChild(div);
    });
}

window.openChatWith = function(empId) {
    if (currentView !== "messages") switchView("messages"); // Prevents the window flick!
    currentChatEmpId = empId;
    const targetEmp = EMPLOYEES.find(e => e.empId === empId);
    
    // FIX 1: Safely check if elements exist before modifying them to prevent crashes!
    if ($("#chat-empty-state")) $("#chat-empty-state").style.display = "none";
    if ($("#chat-active-state")) $("#chat-active-state").style.display = "flex";
    if ($("#chat-search-wrap")) $("#chat-search-wrap").hidden = true;
    if ($("#chat-current-name")) $("#chat-current-name").textContent = targetEmp ? targetEmp.name : empId;
    
    if ($("#chat-formal-composer")) $("#chat-formal-composer").style.display = "none";
    if ($("#chat-form")) $("#chat-form").style.display = (currentChatTab === "formal") ? "none" : "flex";
    
    $$(".chat-convo").forEach(el => el.classList.remove("is-active"));
    const nameToFind = targetEmp ? targetEmp.name : empId;
    const activeConvoEl = Array.from($$(".chat-convo")).find(el => el.innerHTML.includes(nameToFind));
    if (activeConvoEl) activeConvoEl.classList.add("is-active");

    renderChatHistory(empId);
};

function renderChatHistory(targetEmpId) {
    const historyBox = $("#chat-history");
    if(!historyBox) return;
    historyBox.innerHTML = "";
    let hasMessages = false;

    allMessages.forEach(msg => {
        // FIX 2: Stop Formal and Casual messages from leaking into each other!
        const msgType = msg.type || "short";
        if (msgType !== currentChatTab) return; 

        const isDirect = (msg.sender === CURRENT_USER.empId && msg.receiver === targetEmpId) || (msg.sender === targetEmpId && msg.receiver === CURRENT_USER.empId);
        const isCc = (msg.cc === CURRENT_USER.empId && msg.sender === targetEmpId); 
        
        if (isDirect || isCc) {
            if (msg.receiver === CURRENT_USER.empId && !msg.read) {
                updateDoc(doc(db, "messages", msg.id), { read: true }).catch(e => console.warn(e));
            }
            
            hasMessages = true;
            const isSent = msg.sender === CURRENT_USER.empId;
            const bubble = document.createElement("div");
            bubble.className = `chat-bubble ${isSent ? "sent" : "received"}`;
            
            let contentHTML = "";
            
            if (msg.type === "formal") {
                const ccEmp = msg.cc ? EMPLOYEES.find(e => e.empId === msg.cc) : null;
                const ccName = ccEmp ? ccEmp.name : (msg.cc || "None");
                
                // CSS Pattern Background Logic
                let bgStyle = "background: var(--paper-2);";
                if (msg.theme === "geo") {
                    bgStyle = "background: linear-gradient(135deg, rgba(220, 231, 117, 0.4) 50%, rgba(139, 195, 74, 0.4) 50%);";
                } else if (msg.theme === "mosaic") {
                    bgStyle = "background: repeating-linear-gradient(45deg, rgba(139, 195, 74, 0.15) 25%, transparent 25%, transparent 75%, rgba(139, 195, 74, 0.15) 75%, rgba(139, 195, 74, 0.15)), repeating-linear-gradient(45deg, rgba(139, 195, 74, 0.15) 25%, rgba(241, 248, 233, 0.4) 25%, rgba(241, 248, 233, 0.4) 75%, rgba(139, 195, 74, 0.15) 75%, rgba(139, 195, 74, 0.15)); background-position: 0 0, 10px 10px; background-size: 20px 20px;";
                }
                
                // Content sits on a frosted white card over the pattern for readability
                contentHTML += `
                <div style="${bgStyle} padding:16px; border-radius:8px; margin-bottom:6px; text-align:left; border:1px solid var(--line); overflow: hidden; position: relative; min-width: 250px;">
                    <div style="background: rgba(255, 255, 255, 0.95); padding: 16px; border-radius: 6px; box-shadow: var(--shadow-sm); border: 1px solid rgba(0,0,0,0.05);">
                        <div style="font-size: 0.85rem; border-bottom: 1px solid var(--line); padding-bottom: 8px; margin-bottom: 12px; line-height: 1.4; color: var(--ink);">
                            <div style="font-weight:bold; font-size: 0.95rem;">Subject: ${msg.subject || "No Subject"}</div>
                            ${ccName !== "None" ? `<div style="opacity:0.85;">CC: ${ccName}</div>` : ""}
                        </div>
                        <div style="line-height: 1.5; color: var(--ink);">${msg.text.replace(/\n/g, '<br>')}</div>
                    </div>
                </div>`;
            } else {
                contentHTML += `<div style="text-align:left;">${msg.text.replace(/\n/g, '<br>')}</div>`;
            }
            
            if (msg.fileUrl) {
                contentHTML += `<br><a href="${msg.fileUrl}" target="_blank" class="chat-attachment"><img src="${msg.fileUrl}" style="max-width:100%; border-radius:8px; margin-top:8px;"></a>`;
            }
            contentHTML += `<span class="chat-time" style="display:block; text-align:right; margin-top:4px;">${new Date(msg.ts).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>`;
            
            bubble.innerHTML = contentHTML;
            historyBox.appendChild(bubble);
        }
    });

    if (!hasMessages) historyBox.innerHTML = `<div style="text-align: center; color: var(--muted); font-size: .85rem; margin-top: auto;">This is the beginning of your conversation.</div>`;
    historyBox.scrollTop = historyBox.scrollHeight;
}

// --- RESTORED CASUAL SEARCH AUTOCOMPLETE ---
const casualChatInputEl = document.getElementById("chat-recipient");
const casualAutocompleteBox = document.getElementById("chat-autocomplete");

casualChatInputEl?.addEventListener("input", (e) => {
    const val = e.target.value.toLowerCase();
    if(!casualAutocompleteBox) return;
    casualAutocompleteBox.innerHTML = "";
    if (val.length < 1) {
        casualAutocompleteBox.hidden = true;
        return;
    }

    const matches = EMPLOYEES.filter(emp => 
        (emp.name.toLowerCase().includes(val) || emp.empId.toLowerCase().includes(val)) && 
        emp.empId !== CURRENT_USER.empId
    ).slice(0, 5);
    
    if (matches.length > 0) {
        casualAutocompleteBox.hidden = false;
        matches.forEach(match => {
            const div = document.createElement("div");
            div.className = "auto-item";
            div.innerHTML = `
                ${getMiniAvatar(match)}
                <div style="display:flex; flex-direction:column;">
                    <b>${match.name}</b>
                    <span style="font-size:.75rem; color:var(--muted);">${match.empId}</span>
                </div>
            `;
            
            // Explicitly target the window object to prevent crashes
            div.onclick = () => {
                casualAutocompleteBox.hidden = true;
                casualChatInputEl.value = ""; 
                window.openChatWith(match.empId);
            };
            casualAutocompleteBox.appendChild(div);
        });
    } else {
        casualAutocompleteBox.hidden = true;
    }
});

document.addEventListener("click", (e) => {
    if (casualChatInputEl && casualAutocompleteBox && !casualChatInputEl.contains(e.target) && !casualAutocompleteBox.contains(e.target)) {
        casualAutocompleteBox.hidden = true;
    }
});

/* ---------------------------------------------------------
   Compose Dropdown Menu & Chat Logic
   --------------------------------------------------------- */
// 1. Create a sleek dropdown attached to the main Compose button
const oldComposeBtn = document.getElementById("chat-compose-btn");
if (oldComposeBtn) {
    const newComposeBtn = oldComposeBtn.cloneNode(true);
    oldComposeBtn.parentNode.replaceChild(newComposeBtn, oldComposeBtn);

    const composeMenu = document.createElement("div");
    composeMenu.className = "shadow-m";
    composeMenu.style.cssText = "display: none; position: absolute; background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-m); padding: 8px; z-index: 9999; flex-direction: column; gap: 4px; width: 220px;";
    
    composeMenu.innerHTML = `
        <button id="menu-short-msg" style="border:none; background:transparent; text-align:left; padding: 10px 16px; cursor:pointer; font-size:.95rem; font-weight:500; border-radius:4px; display:flex; align-items:center; gap:10px; color:var(--ink);">Compose Casual</button>
        <button id="menu-formal-msg" style="border:none; background:transparent; text-align:left; padding: 10px 16px; cursor:pointer; font-size:.95rem; font-weight:500; border-radius:4px; display:flex; align-items:center; gap:10px; color:var(--ink);">Compose Formal</button>
    `;
    document.body.appendChild(composeMenu);

    const style = document.createElement('style');
    style.innerHTML = `#menu-short-msg:hover, #menu-formal-msg:hover { background: var(--paper-2) !important; color: var(--brand) !important; }`;
    document.head.appendChild(style);

    newComposeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const rect = newComposeBtn.getBoundingClientRect();
        composeMenu.style.top = rect.bottom + 8 + "px";
        composeMenu.style.left = rect.left + "px";
        composeMenu.style.display = "flex";
    });

    document.addEventListener("click", (e) => {
        if (!composeMenu.contains(e.target)) composeMenu.style.display = "none";
    });

    // Option: Casual Message
    document.getElementById("menu-short-msg").addEventListener("click", () => {
        document.querySelector('.chat-tab[data-tab="short"]')?.click(); 
        composeMenu.style.display = "none";
        if (currentView !== "messages") switchView("messages"); // Fixes the flick!
        currentChatEmpId = null;
        
        const formalComposer = document.getElementById("chat-formal-composer");
        const emptyState = document.getElementById("chat-empty-state");
        const activeState = document.getElementById("chat-active-state");
        const searchWrap = document.getElementById("chat-search-wrap");
        const currentName = document.getElementById("chat-current-name");
        const chatInput = document.getElementById("chat-recipient");
        const historyBox = document.getElementById("chat-history");
        
        if(formalComposer) formalComposer.style.display = "none";
        if(emptyState) emptyState.style.display = "none";
        if(activeState) activeState.style.display = "flex";
        if(searchWrap) searchWrap.hidden = false;
        
        if(currentName) currentName.textContent = "New Message";
        if(chatInput) {
            chatInput.value = "";
            chatInput.focus();
        }
        if(historyBox) historyBox.innerHTML = `<div style="text-align: center; color: var(--muted); font-size: .85rem; margin-top: auto;">Search for a coworker to start chatting.</div>`;
        document.querySelectorAll(".chat-convo").forEach(el => el.classList.remove("is-active"));
    });

    // Option: Formal Message
    document.getElementById("menu-formal-msg").addEventListener("click", () => {
        document.querySelector('.chat-tab[data-tab="formal"]')?.click(); 
        composeMenu.style.display = "none";
        if (currentView !== "messages") switchView("messages"); // Fixes the flick!
        
        const activeState = document.getElementById("chat-active-state");
        const emptyState = document.getElementById("chat-empty-state");
        const formalComposer = document.getElementById("chat-formal-composer");
        const formalToInput = document.getElementById("formal-to-input");
        const searchWrap = document.getElementById("chat-search-wrap");
        
        if(activeState) activeState.style.position = "relative"; 
        if(emptyState) emptyState.style.display = "none";
        if(activeState) activeState.style.display = "flex";
        if(formalComposer) formalComposer.style.display = "flex";
        
        if (currentChatEmpId) {
            const targetEmp = EMPLOYEES.find(emp => emp.empId === currentChatEmpId);
            if(formalToInput) formalToInput.value = targetEmp ? targetEmp.name : currentChatEmpId;
        } else {
            if(formalToInput) formalToInput.value = "";
            if(searchWrap) searchWrap.hidden = true; 
        }
        
        const ccInput = document.getElementById("formal-cc-input");
        const subInput = document.getElementById("formal-subject-input");
        const bodyInput = document.getElementById("formal-body-input");
        if(ccInput) ccInput.value = "";
        if(subInput) subInput.value = "";
        if(bodyInput) bodyInput.value = "";
    });
}
// 2. Formal Message Logic & Themes
let currentFormalTheme = "default";
const formalBodyContainer = $("#formal-body-container");

$$(".theme-swatch").forEach(swatch => {
    swatch.addEventListener("click", (e) => {
        $$(".theme-swatch").forEach(s => s.style.borderColor = "transparent");
        if (e.target.dataset.theme === "default") e.target.style.borderColor = "var(--brand)";
        else e.target.style.borderColor = "var(--ink)";
        
        currentFormalTheme = e.target.dataset.theme;
        
        // Instantly apply the chosen pattern to the composer background!
        if (currentFormalTheme === "geo") {
            formalBodyContainer.style.background = "linear-gradient(135deg, rgba(220, 231, 117, 0.4) 50%, rgba(139, 195, 74, 0.4) 50%)";
        } else if (currentFormalTheme === "mosaic") {
            formalBodyContainer.style.background = "repeating-linear-gradient(45deg, rgba(139, 195, 74, 0.15) 25%, transparent 25%, transparent 75%, rgba(139, 195, 74, 0.15) 75%, rgba(139, 195, 74, 0.15)), repeating-linear-gradient(45deg, rgba(139, 195, 74, 0.15) 25%, rgba(241, 248, 233, 0.4) 25%, rgba(241, 248, 233, 0.4) 75%, rgba(139, 195, 74, 0.15) 75%, rgba(139, 195, 74, 0.15))";
            formalBodyContainer.style.backgroundPosition = "0 0, 10px 10px";
            formalBodyContainer.style.backgroundSize = "20px 20px";
        } else {
            formalBodyContainer.style.background = "var(--card)";
        }
    });
});

// Formal Auto-complete Logic for To & Cc
function setupFormalAutocomplete(inputId, boxId) {
    const inputEl = $(inputId);
    const boxEl = $(boxId);
    
    inputEl?.addEventListener("input", (e) => {
        const val = e.target.value.toLowerCase();
        boxEl.innerHTML = "";
        if (val.length < 1) {
            boxEl.hidden = true;
            return;
        }
        const matches = EMPLOYEES.filter(emp => 
            (emp.name.toLowerCase().includes(val) || emp.empId.toLowerCase().includes(val)) && 
            emp.empId !== CURRENT_USER.empId
        ).slice(0, 5);
        
        if (matches.length > 0) {
            boxEl.hidden = false;
            matches.forEach(match => {
                const div = document.createElement("div");
                div.className = "auto-item";
                div.innerHTML = `${getMiniAvatar(match)}<div style="display:flex; flex-direction:column;"><b>${match.name}</b><span style="font-size:.75rem; color:var(--muted);">${match.empId}</span></div>`;
                div.onclick = () => {
                    inputEl.value = match.name; // Fill input with name
                    boxEl.hidden = true;
                };
                boxEl.appendChild(div);
            });
        } else {
            boxEl.hidden = true;
        }
    });

    // Close dropdown when clicking outside
    document.addEventListener("click", (e) => {
        if (inputEl && boxEl && !inputEl.contains(e.target) && !boxEl.contains(e.target)) {
            boxEl.hidden = true;
        }
    });
}

setupFormalAutocomplete("#formal-to-input", "#formal-to-autocomplete");
setupFormalAutocomplete("#formal-cc-input", "#formal-cc-autocomplete");

function resetFormalComposer() {
    $("#chat-formal-composer").style.display = "none";
    $("#formal-cc-input").value = "";
    $("#formal-subject-input").value = "";
    $("#formal-body-input").value = "";
    if (fileInputFormal) fileInputFormal.value = "";
    $("#formal-attach-btn").style.color = "var(--brand)"; 
    document.querySelector('.theme-swatch[data-theme="default"]')?.click(); // Reset theme
}

$("#formal-discard-btn")?.addEventListener("click", () => {
    resetFormalComposer();
    if (!currentChatEmpId) {
        $("#chat-active-state").style.display = "none";
        $("#chat-empty-state").style.display = "flex";
        $("#chat-search-wrap").hidden = false;
    }
});

const fileInputFormal = $("#formal-file-input");
$("#formal-attach-btn")?.addEventListener("click", () => fileInputFormal?.click());
fileInputFormal?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file && !file.type.startsWith('image/')) {
        alert("Only image files are supported."); e.target.value = "";
    } else if (file) {
        $("#formal-attach-btn").style.color = "var(--present)"; 
    }
});

$("#formal-send-btn")?.addEventListener("click", async () => {
    const toVal = $("#formal-to-input").value.trim().toLowerCase();
    const ccVal = $("#formal-cc-input").value.trim().toLowerCase();
    const subjectVal = $("#formal-subject-input").value.trim();
    const bodyVal = $("#formal-body-input").value.trim();
    const file = fileInputFormal?.files[0];
    
    if (!toVal) return alert("Please specify a recipient.");
    if (!bodyVal && !file) return alert("Message body cannot be empty.");

    const toEmp = EMPLOYEES.find(emp => emp.name.toLowerCase().includes(toVal) || emp.empId.toLowerCase() === toVal);
    if (!toEmp) return alert("Recipient not found. Double-check their Name or ID.");

    let finalCcId = null;
    if (ccVal) {
        const ccEmp = EMPLOYEES.find(emp => emp.name.toLowerCase().includes(ccVal) || emp.empId.toLowerCase() === ccVal);
        if (ccEmp) finalCcId = ccEmp.empId;
        else return alert("CC recipient not found.");
    }

    const btn = $("#formal-send-btn");
    btn.disabled = true;
    btn.textContent = "Sending...";

    try {
        let fileUrl = null;
        if (file) fileUrl = await compressImage(file, 800); 

        await addDoc(collection(db, "messages"), {
            sender: CURRENT_USER.empId,
            receiver: toEmp.empId,
            type: "formal",
            subject: subjectVal,
            cc: finalCcId,
            theme: currentFormalTheme,
            text: bodyVal,
            fileUrl: fileUrl, 
            ts: Date.now(),
            read: false
        });

        resetFormalComposer();
        if (currentChatEmpId !== toEmp.empId) window.openChatWith(toEmp.empId);
        
    } catch (error) {
        console.error("Message error:", error);
        notifyEvent("danger", "Failed to send", "Check your internet connection.");
    } finally {
        btn.disabled = false;
        btn.textContent = "Send Message";
    }
});

// 3. Restored Short Message Logic
const chatForm = $("#chat-form");
const chatAttachBtn = $("#chat-attach-btn");
const chatFileInput = $("#chat-file");
const chatInputText = $("#chat-input-text");

chatAttachBtn?.addEventListener("click", () => chatFileInput?.click());
chatFileInput?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file && !file.type.startsWith('image/')) {
        alert("Only image files are supported."); chatFileInput.value = "";
    } else if (file) {
        chatAttachBtn.style.color = "var(--present)"; 
    }
});

chatForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = chatFileInput?.files[0];
    if (!currentChatEmpId) return alert("Please select someone to message.");

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending...";

    try {
        let fileUrl = null;
        if (file) fileUrl = await compressImage(file, 800); 

        await addDoc(collection(db, "messages"), {
            sender: CURRENT_USER.empId,
            receiver: currentChatEmpId,
            type: "short",
            text: chatInputText.value,
            fileUrl: fileUrl, 
            ts: Date.now(),
            read: false
        });

        chatInputText.value = "";
        if(chatFileInput) chatFileInput.value = "";
        if(chatAttachBtn) chatAttachBtn.style.color = ""; 
        
    } catch (error) {
        console.error("Message error:", error);
        notifyEvent("danger", "Failed to send", "Check your internet connection.");
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Send";
    }
});
/* ---------------------------------------------------------
   Admin Global Chat Audit Logic
   --------------------------------------------------------- */
let currentAdminChatKey = null;

function renderAdminGlobalChats() {
    const list = $("#admin-global-chat-list");
    if (!list) return;
    list.innerHTML = "";

    const globalConvoMap = new Map();

    allMessages.forEach(msg => {
        const pair = [msg.sender, msg.receiver].sort();
        const key = pair.join("_");
        if (!globalConvoMap.has(key) || globalConvoMap.get(key).ts < msg.ts) {
            globalConvoMap.set(key, msg);
        }
    });

    const sortedGlobal = Array.from(globalConvoMap.entries()).sort((a, b) => b[1].ts - a[1].ts);

    sortedGlobal.forEach(([key, latestMsg]) => {
        const [id1, id2] = key.split("_");
        const emp1 = EMPLOYEES.find(e => e.empId === id1);
        const emp2 = EMPLOYEES.find(e => e.empId === id2);
        if (!emp1 || !emp2) return; 

        const div = document.createElement("div");
        // FIX: Add a strict data-key to prevent highlighting the wrong chats!
        div.className = `chat-convo ${currentAdminChatKey === key ? "is-active" : ""}`;
        div.dataset.key = key; 
        
        let preview = latestMsg.text || "📎 Image Attached";
        
        div.innerHTML = `
            <div class="chat-convo-info">
               <div class="chat-convo-name">${emp1.name} ↔ ${emp2.name}</div>
               <div class="chat-convo-preview">${preview}</div>
            </div>
        `;
        div.onclick = () => window.openAdminGlobalChat(key, emp1, emp2);
        list.appendChild(div);
    });
    
    if (currentAdminChatKey) {
        const [id1, id2] = currentAdminChatKey.split("_");
        renderAdminChatHistory(id1, id2);
    }
}

window.openAdminGlobalChat = function(key, emp1, emp2) {
    currentAdminChatKey = key;
    $("#admin-chat-empty").style.display = "none";
    $("#admin-chat-active").style.display = "flex";
    $("#admin-chat-title").textContent = `Audit: ${emp1.name} & ${emp2.name}`;
    
    // FIX: Safely select using the exact data-key
    $$("#admin-global-chat-list .chat-convo").forEach(el => el.classList.remove("is-active"));
    const activeConvoEl = document.querySelector(`#admin-global-chat-list .chat-convo[data-key="${key}"]`);
    if (activeConvoEl) activeConvoEl.classList.add("is-active");

    renderAdminChatHistory(emp1.empId, emp2.empId);
};

function renderAdminChatHistory(id1, id2) {
    const historyBox = $("#admin-chat-history");
    if (!historyBox) return;
    historyBox.innerHTML = "";
    
    allMessages.forEach(msg => {
        if ((msg.sender === id1 && msg.receiver === id2) || (msg.sender === id2 && msg.receiver === id1)) {
            const senderEmp = EMPLOYEES.find(e => e.empId === msg.sender);
            
            const bubble = document.createElement("div");
            bubble.style.marginBottom = "20px";
            
            let formalHtml = "";
            if (msg.type === "formal") {
                const ccEmp = msg.cc ? EMPLOYEES.find(e => e.empId === msg.cc) : null;
                const ccName = ccEmp ? ccEmp.name : (msg.cc || "None");
                formalHtml = `<div style="background:var(--paper-2); padding:10px 14px; border-radius:6px; margin-bottom:8px; font-size:0.85rem; border:1px solid var(--line);">
                    <div><b>Subject:</b> ${msg.subject || "No Subject"}</div>
                    <div style="color:var(--muted);"><b>CC:</b> ${ccName}</div>
                </div>`;
            }

            // Clean Timeline UI Redesign
            let contentHTML = `
            <div style="display:flex; gap:12px; align-items:flex-start;">
                ${getMiniAvatar(senderEmp)}
                <div style="flex:1; min-width:0;">
                    <div style="display:flex; align-items:baseline; gap:8px; margin-bottom:4px;">
                        <b style="color:var(--ink); font-size:.95rem;">${senderEmp ? senderEmp.name : msg.sender}</b>
                        <span style="font-size:0.75rem; color:var(--muted);">${new Date(msg.ts).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})}</span>
                    </div>
                    ${formalHtml}
                    <div style="font-size: .95rem; color: var(--ink); line-height: 1.5; padding-top: 4px;">
                        ${msg.text.replace(/\n/g, '<br>')}
                        ${msg.fileUrl ? `<br><a href="${msg.fileUrl}" target="_blank"><img src="${msg.fileUrl}" style="max-width:250px; border-radius:6px; margin-top:12px; border:1px solid var(--line); display:block;"></a>` : ''}
                    </div>
                </div>
            </div>`;
            
            bubble.innerHTML = contentHTML;
            historyBox.appendChild(bubble);
        }
    });
    
    historyBox.scrollTop = historyBox.scrollHeight;
}

$("#admin-chat-print-btn")?.addEventListener("click", () => {
    window.print();
});