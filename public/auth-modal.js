(function () {
    if (window.TicketmasterAuthModalReady) {
        return;
    }

    const template = `
        <div id="loginModal" class="auth-modal" aria-hidden="true">
            <div class="auth-panel" role="dialog" aria-modal="true" aria-label="Iniciar sesion">
                <div class="login-head">
                    <h3>Iniciar sesion</h3>
                    <button id="closeLoginIcon" class="icon-close" type="button" aria-label="Cerrar login">X</button>
                </div>
                <div class="auth-grid auth-grid-vertical">
                    <label class="field-label" for="loginEmail">Correo electronico</label>
                    <input id="loginEmail" type="email" placeholder="correo@gmail.com" autocomplete="off" autocapitalize="off" spellcheck="false">
                    <label class="field-label" for="loginPassword">Contrasena</label>
                    <input id="loginPassword" type="password" placeholder="******" autocomplete="new-password">
                </div>
                <div class="auth-actions">
                    <button id="doLogin" class="action-primary login-submit" type="button">Iniciar sesion</button>
                </div>
                <p class="switch-note">No tienes cuenta?
                    <button id="openRegisterFromLogin" class="switch-link" type="button">Registrarte</button>
                </p>
            </div>
        </div>

        <div id="registerModal" class="auth-modal" aria-hidden="true">
            <div class="auth-panel" role="dialog" aria-modal="true" aria-label="Registro de usuario">
                <div class="register-head">
                    <h3>Registrarme</h3>
                    <button id="closeRegisterIcon" class="icon-close" type="button" aria-label="Cerrar registro">X</button>
                </div>
                <div class="auth-grid auth-grid-vertical">
                    <label class="field-label" for="regName">Nombre de usuario</label>
                    <input id="regName" type="text" placeholder="Ingresa usuario" autocomplete="off" autocapitalize="words" spellcheck="false">
                    <label class="field-label" for="regEmail">Correo electronico</label>
                    <input id="regEmail" type="email" placeholder="Ingresa correo" autocomplete="off" autocapitalize="off" spellcheck="false">
                    <label class="field-label" for="regPassword">Contrasena</label>
                    <input id="regPassword" type="password" placeholder="******" autocomplete="new-password">
                    <label class="field-label" for="regPasswordConfirm">Confirmar contrasena</label>
                    <input id="regPasswordConfirm" type="password" placeholder="******" autocomplete="new-password">
                    <div id="regRoleWrap" class="full hidden">
                        <label class="field-label" for="regRole">Rol</label>
                        <select id="regRole">
                            <option value="user">Usuario</option>
                            <option value="organizer">Organizador</option>
                            <option value="admin">Admin</option>
                        </select>
                    </div>
                    <p id="regRoleHint" class="full switch-note switch-note-left">Solo los administradores pueden elegir un rol avanzado.</p>
                </div>
                <div class="auth-actions">
                    <button id="doRegister" class="action-primary login-submit" type="button">Crear mi cuenta</button>
                </div>
                <p class="switch-note">Ya tienes una cuenta?
                    <button id="openLoginFromRegister" class="switch-link" type="button">Iniciar Sesion</button>
                </p>
            </div>
        </div>`;

    document.body.insertAdjacentHTML('beforeend', template);

    const loginModal = document.getElementById('loginModal');
    const registerModal = document.getElementById('registerModal');
    const regRoleWrap = document.getElementById('regRoleWrap');
    const regRoleHint = document.getElementById('regRoleHint');

    function parseUserFromToken(token) {
        try {
            const payload = token.split('.')[1];
            const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
            const json = atob(normalized);
            const data = JSON.parse(json);
            if (!data || !data.id || !data.role) {
                return null;
            }
            return { id: data.id, role: data.role, name: data.role };
        } catch (err) {
            return null;
        }
    }

    function clearLoginForm() {
        const email = document.getElementById('loginEmail');
        const password = document.getElementById('loginPassword');
        if (email) email.value = '';
        if (password) password.value = '';
    }

    function clearRegisterForm() {
        const name = document.getElementById('regName');
        const email = document.getElementById('regEmail');
        const password = document.getElementById('regPassword');
        const confirmPassword = document.getElementById('regPasswordConfirm');
        const role = document.getElementById('regRole');
        if (name) name.value = '';
        if (email) email.value = '';
        if (password) password.value = '';
        if (confirmPassword) confirmPassword.value = '';
        if (role) role.value = 'user';
    }

    function openLoginModal() {
        clearLoginForm();
        loginModal.classList.add('open');
        loginModal.setAttribute('aria-hidden', 'false');
    }

    function closeLoginModal() {
        clearLoginForm();
        loginModal.classList.remove('open');
        loginModal.setAttribute('aria-hidden', 'true');
    }

    function openRegisterModal() {
        clearRegisterForm();
        const storedUser = localStorage.getItem('tm_user');
        let currentUser = null;
        if (storedUser) {
            try { currentUser = JSON.parse(storedUser); } catch (err) { currentUser = null; }
        }
        const token = localStorage.getItem('tm_token') || null;
        if (!currentUser && token) {
            currentUser = parseUserFromToken(token);
        }
        const isAdmin = currentUser?.role === 'admin';
        regRoleWrap.classList.toggle('hidden', !isAdmin);
        regRoleHint.classList.toggle('hidden', isAdmin);
        const regRole = document.getElementById('regRole');
        if (regRole && !isAdmin) {
            regRole.value = 'user';
        }
        registerModal.classList.add('open');
        registerModal.setAttribute('aria-hidden', 'false');
    }

    function closeRegisterModal() {
        clearRegisterForm();
        registerModal.classList.remove('open');
        registerModal.setAttribute('aria-hidden', 'true');
    }

    document.getElementById('closeLoginIcon').addEventListener('click', closeLoginModal);
    document.getElementById('closeRegisterIcon').addEventListener('click', closeRegisterModal);
    document.getElementById('openRegisterFromLogin').addEventListener('click', () => {
        closeLoginModal();
        openRegisterModal();
    });
    document.getElementById('openLoginFromRegister').addEventListener('click', () => {
        closeRegisterModal();
        openLoginModal();
    });

    window.openLoginModal = openLoginModal;
    window.closeLoginModal = closeLoginModal;
    window.openRegisterModal = openRegisterModal;
    window.closeRegisterModal = closeRegisterModal;
    window.TicketmasterAuthModalReady = true;
})();