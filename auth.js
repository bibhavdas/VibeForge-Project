import { signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, setDoc, getDoc, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db } from "./firebase.js";

/* ============================================================
   Alignt HRMS — sign-in / sign-up page logic
   ============================================================ */

let authRole = "employee";
let signupRole = "employee";

const notiSound = new Audio("noti.mp3");

// Standard Password Regex: Min 8 characters, at least 1 uppercase, 1 lowercase, 1 number, 1 special character
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

function playNotiSound() {
    notiSound.play().catch(e => console.warn("Audio play prevented", e));
}

function initAuth(){
  if (typeof Notify !== "undefined"){
    Notify.init({ position: "top-right", defaultDuration: 6000 });
  }

  let badge = { flip(){}, destroy(){} };
  try {
    badge = createBadge($("#badge-canvas"));
  } catch (err) {
    console.warn("Badge visual unavailable:", err);
  }

  const punchBtn = $("#punch-btn");
  if (punchBtn) punchBtn.addEventListener("click", () => badge.flip());

  $$(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      $$(".auth-tab").forEach(t => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      const target = tab.dataset.tab;
      
      $$(".auth-form").forEach(f => f.classList.remove("is-active"));
      const showEl = target === "signin" ? $("#signin-form") : $("#signup-form");
      showEl.classList.add("is-active");
      
      anime({ targets: showEl, opacity: [0, 1], translateY: [8, 0], duration: 320, easing: "easeOutQuad" });
    });
  });

  $$("[data-role-toggle] .role-opt").forEach(btn => {
    btn.addEventListener("click", () => {
      $$("[data-role-toggle] .role-opt").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      authRole = btn.dataset.role;
    });
  });
  
  $$("[data-role-toggle-signup] .role-opt").forEach(btn => {
    btn.addEventListener("click", () => {
      $$("[data-role-toggle-signup] .role-opt").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      signupRole = btn.dataset.role;
    });
  });

  // Toggle Password Visibility
  $$(".pwd-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = btn.previousElementSibling;
      if (input.type === "password") {
        input.type = "text";
        btn.style.color = "var(--brand)"; 
      } else {
        input.type = "password";
        btn.style.color = "var(--muted)";
      }
    });
  });

  // --- REAL FIREBASE SIGN IN ---
  $("#signin-form").addEventListener("submit", e => {
    e.preventDefault();
    const email = $("#signin-email").value.trim();
    const password = $("#signin-password").value;
    const errorEl = $("#signin-error");

    if (!email || !password){
      errorEl.textContent = "Enter a valid email and password to continue.";
      errorEl.hidden = false;
      return;
    }
    
    errorEl.hidden = true;
    const submitBtn = $("#signin-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in...";

    signInWithEmailAndPassword(auth, email, password)
      .then(async (userCredential) => {
          const user = userCredential.user;

          // -------------------------------------------------------------
          // LEGACY BYPASS: Check if the account was created BEFORE today.
          // If it's an old account, we skip the email verification check.
          // -------------------------------------------------------------
          const creationTime = new Date(user.metadata.creationTime).getTime();
          const cutoffTime = new Date("2026-07-13T00:00:00Z").getTime(); 
          const isLegacyUser = creationTime < cutoffTime;

          // STRICT ENFORCEMENT: Block login if email is not verified AND it's a new account
          if (!user.emailVerified && !isLegacyUser) {
              await signOut(auth); // Instantly log them out
              submitBtn.disabled = false;
              submitBtn.textContent = "Sign in";
              
              playNotiSound();
              if (typeof Notify !== "undefined") {
                  Notify.notify({ type: "warning", title: "Unverified Email", message: "Please check your inbox and click the verification link before logging in." });
              } else {
                  errorEl.textContent = "Please verify your email first. Check your inbox.";
                  errorEl.hidden = false;
              }
              return;
          }
          
          // If verified (or legacy), proceed normally
          try {
              const userDoc = await getDoc(doc(db, "users", email));
              
              let userData = userDoc.exists() ? userDoc.data() : null;
              
              // Sanitization: Ensure legacy ghost accounts don't pull "AU-00000" or "Employee"
              if (!userData) {
                  userData = { name: user.displayName || deriveNameFromEmail(email), empId: "AU-Pending", role: authRole };
              } else {
                  if (userData.empId === "AU-00000") userData.empId = "AU-Pending";
                  if (userData.name === "Employee") userData.name = deriveNameFromEmail(email);
              }
              
              const session = {
                  name: userData.name, 
                  empId: userData.empId, 
                  email: user.email,
                  role: userData.role,
                  createdAt: userData.createdAt || Date.now()
              };
              
              setSession(session);
              window.location.href = "dashboard.html";
          } catch(err) {
              console.error("Firestore retrieval error:", err);
              errorEl.textContent = "Error securely fetching your profile data.";
              errorEl.hidden = false;
              submitBtn.disabled = false;
              submitBtn.textContent = "Sign in";
          }
      })
      .catch((error) => {
          console.error("Firebase Auth Error:", error.code);
          submitBtn.disabled = false;
          submitBtn.textContent = "Sign in";
          
          if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential') {
              errorEl.textContent = "This email is not registered or credentials invalid.";
              errorEl.hidden = false;
          } else {
              errorEl.textContent = "Sign-in failed. Please check your credentials.";
              errorEl.hidden = false;
          }
      });
  });

  // --- REAL FIREBASE SIGN UP ---
  $("#signup-form").addEventListener("submit", e => {
    e.preventDefault();
    const name = $("#signup-name").value.trim();
    const email = $("#signup-email").value.trim();
    const password = $("#signup-password").value;
    
    // STRICT PASSWORD VALIDATION
    if (!PASSWORD_REGEX.test(password)) {
        playNotiSound();
        if (typeof Notify !== "undefined") {
            Notify.notify({
                type: "danger",
                title: "Weak Password",
                message: "Password must be at least 8 characters long and contain at least 1 uppercase letter, 1 lowercase letter, 1 number, and 1 special symbol (@$!%*?&)."
            });
        } else {
            toast("Password too weak. Needs uppercase, number, and special character.", "danger");
        }
        return;
    }

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating account...";

    createUserWithEmailAndPassword(auth, email, password)
      .then(async (userCredential) => {
          const user = userCredential.user;

          // 1. Send the Verification Email immediately
          await sendEmailVerification(user);

          // 2. Generate AU-XXXXX ID securely
          let newEmpId = "AU-00001";
          try {
              const usersSnap = await getDocs(collection(db, "users"));
              const nextCount = usersSnap.size + 1;
              newEmpId = "AU-" + String(nextCount).padStart(5, '0');
          } catch (err) {
              newEmpId = "AU-" + Math.floor(10000 + Math.random() * 90000);
          }

          const joinedTs = Date.now();
          const joinedStr = new Date(joinedTs).toLocaleDateString("en-IN", { day: 'numeric', month: 'short', year: 'numeric' });

          // 3. Save to Firestore
          await setDoc(doc(db, "users", email), {
              name: name,
              empId: newEmpId,
              email: email,
              role: signupRole,
              department: "—",
              status: "absent",
              joined: joinedStr,
              createdAt: joinedTs
          });

          // 4. FORCE LOGOUT so they cannot enter the dashboard unverified
          await signOut(auth);

          playNotiSound();
          if (typeof Notify !== "undefined") {
              Notify.notify({ type: "success", title: "Account Created!", message: `A verification link has been sent to ${email}. Please check your inbox before logging in.`});
          } else {
              toast(`Account created! Please verify your email first.`);
          }
          
          e.target.reset();
          $$(".auth-tab")[0].click(); // Switch back to sign in tab
          $("#signin-email").value = email;
      })
      .catch((error) => {
          console.error("Firebase Auth Error:", error.code);
          playNotiSound();
          if (error.code === 'auth/email-already-in-use') {
              if (typeof Notify !== "undefined") Notify.notify({type: "warning", title: "Email taken", message: "This email is already registered."});
              else toast(`This email is already registered.`, 'warning');
          } else {
              if (typeof Notify !== "undefined") Notify.notify({type: "danger", title: "Sign-up failed", message: error.message});
              else toast(`Sign-up failed: ${error.message}`, 'danger');
          }
      })
      .finally(() => {
          submitBtn.disabled = false;
          submitBtn.textContent = "Create account";
      });
  });
}

clearSession();
initAuth();
