const $ = (id) => document.getElementById(id);

let identity = null;
let authMode = 'login';
let currentMessages = [];
let chatSource = null;
let seenMessageIds = new Set();
let unreadCount = 0;
let messageFilter = 'all';
let submissionSearchQuery = '';
let bulkGradingAssignmentId = null;

function setToken(token) {
  if (token) localStorage.setItem('zorachi_token', token);
  else localStorage.removeItem('zorachi_token');
}

function getToken() {
  return localStorage.getItem('zorachi_token');
}

function authFetch(url, options = {}) {
  options.headers = options.headers || {};
  const token = getToken();
  if (token) options.headers.Authorization = `Bearer ${token}`;
  return fetch(url, options);
}

function showScreen(authenticated) {
  $('loginScreen').classList.toggle('hidden', authenticated);
  $('appScreen').classList.toggle('hidden', !authenticated);
}

function updateUI() {
  const isStaff = identity.role === 'teacher' || identity.role === 'admin';
  $('assignmentForm').classList.toggle('hidden', !isStaff);
  $('adminPanel').classList.toggle('hidden', !isStaff);
  $('embeddingSearchPanel').classList.toggle('hidden', !isStaff);
  $('teacherSearchArea').classList.toggle('hidden', !isStaff);
  $('teacherHubSection')?.classList.toggle('hidden', !isStaff);
  $('userInfo').textContent = `${identity.name} • ${identity.role}`;
  document.body.className = identity.role;
  updateUnreadBadge();
  if (isStaff) {
    initTeacherHub();
    refreshAdmin();
  }
}

function updateUnreadBadge() {
  const badge = $('unreadBadge');
  if (!badge) return;
  if (unreadCount > 0) {
    badge.textContent = `${unreadCount} new`;
    badge.classList.remove('hidden');
  } else {
    badge.textContent = '';
    badge.classList.add('hidden');
  }
}

function appendMessage(msg) {
  if (currentMessages.some(m => m.id === msg.id)) return;
  currentMessages.push(msg);
  if (!seenMessageIds.has(msg.id) && msg.from !== identity.name) {
    unreadCount += 1;
    updateUnreadBadge();
  }
  renderMessages(currentMessages);
}

function connectEventSource() {
  disconnectEventSource();
  const token = getToken();
  if (!token) return;
  chatSource = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  chatSource.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      appendMessage(msg);
    } catch (err) {
      console.warn('Failed to parse chat event', err);
    }
  });
  chatSource.addEventListener('error', () => {
    console.warn('Chat connection lost, retrying...');
  });
}

function disconnectEventSource() {
  if (chatSource) {
    chatSource.close();
    chatSource = null;
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const isLogin = mode === 'login';
  const isSignup = mode === 'signup';
  const isForgot = mode === 'forgot';
  $('firstNameLabel').classList.toggle('hidden', !(isSignup || isForgot));
  $('lastNameLabel').classList.toggle('hidden', !(isSignup || isForgot));
  $('otherNameLabel').classList.toggle('hidden', !isSignup); // 'Other Name' is only for signup
  $('loginAction').textContent = isLogin ? 'Log in' : isSignup ? 'Sign up' : 'Reset password';
  $('authHelp').classList.toggle('hidden', isForgot);
  $('forgotHelp').classList.toggle('hidden', !isForgot);
  $('forgotPasswordText').classList.toggle('hidden', isForgot);
  $('authToggleText').textContent = isLogin ? "Don't have an account?" : 'Remembered your password?';
  $('authToggleLink').textContent = isLogin ? 'Sign up' : 'Log in';
}

async function loginUser(event) {
  event.preventDefault();
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value.trim();
  const role = $('loginRole').value; // Role is always present in the form
  let firstName = '';
  let lastName = '';
  let otherName = '';

  if (authMode === 'signup' || authMode === 'forgot') {
    firstName = $('loginFirstName').value.trim();
    lastName = $('loginLastName').value.trim();
    if (authMode === 'signup') {
      otherName = $('loginOtherName').value.trim();
    }
  }

  if (!email || !password || ((authMode === 'signup' || authMode === 'forgot') && (!firstName || !lastName))) {
    return alert('Please enter email, password, first name, and last name');
  }

  const endpoint = authMode === 'login' ? '/api/login' : authMode === 'signup' ? '/api/signup' : '/api/forgot-password';
  const requestBody = { email, password, role, firstName, lastName };
  if (authMode === 'signup') requestBody.otherName = otherName;

  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });

  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Authentication failed');
  if (authMode === 'forgot') {
    alert('Password reset successfully! Please log in with your new password.');
    setAuthMode('login');
    return;
  }

  if (authMode === 'signup') {
    alert('Signup successful! Please log in with your new account.');
    // Clear signup-only fields but keep email, password, and role for login
    $('loginFirstName').value = '';
    $('loginLastName').value = '';
    $('loginOtherName').value = '';
    setAuthMode('login');
    return;
  }

  setToken(data.token);
  identity = { name: data.name, role: data.role, email: data.email, firstName: data.firstName, lastName: data.lastName, otherName: data.otherName };
  updateUI();
  showScreen(true);
  connectEventSource();
  refresh();
}

function logoutUser() {
  identity = null;
  setToken(null);
  disconnectEventSource();
  showScreen(false);
}

async function restoreSession() {
  const token = getToken();
  if (!token) return;
  const res = await authFetch('/api/profile');
  if (!res.ok) { logoutUser(); return; }
  identity = await res.json();
  updateUI();
  showScreen(true);
  connectEventSource();
  refresh();
}

async function fetchMessages() {
  const r = await authFetch('/api/messages');
  return await r.json();
}

async function fetchAssignments() {
  const r = await authFetch('/api/assignments');
  return await r.json();
}

async function fetchAdminSummary() {
  const r = await authFetch('/api/admin/summary');
  return await r.json();
}

async function fetchAdminUsers() {
  const r = await authFetch('/api/admin/users');
  return await r.json();
}

async function fetchSearchEmbeddings(query) {
  const r = await authFetch('/api/embeddings/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, topK: 8 })
  });
  if (!r.ok) {
    const err = await r.json();
    throw new Error(err.error || 'Search failed');
  }
  return await r.json();
}

function renderMessages(list) {
  const el = $('messages');
  el.innerHTML = '';
  const filtered = (list || []).filter(msg => {
    if (messageFilter === 'unread') {
      return !seenMessageIds.has(msg.id) && msg.from !== identity.name;
    }
    if (messageFilter === 'unresolved') {
      return !msg.resolved;
    }
    if (messageFilter === 'resolved') {
      return msg.resolved;
    }
    return true;
  });
  const tree = buildMessageTree(filtered);
  tree.forEach(msg => {
    el.appendChild(renderMessageNode(msg));
  });
}

function renderAssignments(list) {
  const el = $('assignments');
  el.innerHTML = '';

  // Filter assignments: only show assignments that contain matching submissions if searching
  const filteredAssignments = list.filter(a => {
    if (!submissionSearchQuery) return true;
    const subs = Array.isArray(a.submissions) ? a.submissions : [];
    const query = submissionSearchQuery.toLowerCase();
    return subs.some(s => s.learner.toLowerCase().includes(query));
  });

  filteredAssignments.forEach(async (a) => {
    const d = document.createElement('div');
    d.className = 'assignment';
    
    const isStaff = identity.role === 'teacher' || identity.role === 'admin';
    const isBulkMode = bulkGradingAssignmentId === a.id;

    d.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:start;">
        <div>
          <h3>${escapeHtml(a.title)} <small style="font-weight:normal; font-size:0.6em; color:#666;">(Target: ${escapeHtml(a.target || 'All')})</small></h3>
          <p>${escapeHtml(a.description || '')}</p>
          <small>By ${escapeHtml(a.teacher)}</small>
        </div>
        ${isStaff ? `<button class="bulk-toggle-btn" style="background:#6c757d; font-size:0.8em;">${isBulkMode ? 'Exit Bulk Grading' : 'Bulk Grade Submissions'}</button>` : ''}
      </div>
    `;

    d.querySelector('.bulk-toggle-btn')?.addEventListener('click', () => {
      bulkGradingAssignmentId = isBulkMode ? null : a.id;
      renderAssignments(list);
    });

    const ul = document.createElement('div');
    ul.className = 'submissions';

    if (isBulkMode) {
      ul.innerHTML = `
        <div style="margin-top:15px; background:#fff; padding:10px; border-radius:8px; border:1px solid #ddd;">
          <table style="width:100%; border-collapse:collapse; font-size:0.9em;">
            <thead>
              <tr style="border-bottom:2px solid #eee; text-align:left;">
                <th style="padding:8px;">Learner</th>
                <th style="padding:8px;">Content Preview</th>
                <th style="padding:8px;">Grade</th>
                <th style="padding:8px;">Recommendation</th>
              </tr>
            </thead>
            <tbody id="bulkTableBody-${a.id}"></tbody>
          </table>
          <div style="margin-top:10px; text-align:right;">
            <button class="save-bulk-btn" style="background:#28a745; color:white; border:none; padding:8px 20px; border-radius:4px; cursor:pointer;">Save All Marks</button>
          </div>
        </div>
      `;

      const tbody = ul.querySelector(`#bulkTableBody-${a.id}`);
      a.submissions.forEach(s => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #eee';
        tr.dataset.submissionId = s.id;
        tr.innerHTML = `
          <td style="padding:8px;"><strong>${escapeHtml(s.learner)}</strong></td>
          <td style="padding:8px; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(s.content)}</td>
          <td style="padding:8px;"><input type="text" class="bulk-grade" value="${escapeHtml(s.grade || '')}" style="width:60px;"></td>
          <td style="padding:8px;"><input type="text" class="bulk-rec" value="${escapeHtml(s.recommendation || '')}" style="width:100%;"></td>
        `;
        tbody.appendChild(tr);
      });

      ul.querySelector('.save-bulk-btn').addEventListener('click', async () => {
        const results = Array.from(tbody.querySelectorAll('tr')).map(tr => ({
          submissionId: Number(tr.dataset.submissionId),
          grade: tr.querySelector('.bulk-grade').value.trim(),
          recommendation: tr.querySelector('.bulk-rec').value.trim()
        }));
        
        try {
          const res = await authFetch(`/api/assignments/${a.id}/bulk-grade`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ results })
          });
          if (!res.ok) throw new Error('Bulk update failed');
          alert('All marks uploaded successfully!');
          bulkGradingAssignmentId = null;
          refresh();
        } catch (err) { alert(err.message); }
      });

    } else {
      ul.innerHTML = '<strong>Submissions:</strong>';
    }
    
    // Filter submissions based on teacher search query
    let submissions = Array.isArray(a.submissions) ? a.submissions : [];

    // Role-based visibility: Learners and parents see only their own submissions
    if (identity.role === 'learner') {
      submissions = submissions.filter(s => s.learner === identity.name);
    } else if (identity.role === 'parent') {
      submissions = submissions.filter(s => s.parent === identity.name);
    }

    if (submissionSearchQuery) {
      submissions = submissions.filter(s => 
        s.learner.toLowerCase().includes(submissionSearchQuery.toLowerCase())
      );
    }

    if (submissions.length === 0) {
      const none = document.createElement('div');
      none.className = 'submission none';
      none.textContent = submissionSearchQuery ? 'No matching submissions found.' : 'No submissions yet.';
      ul.appendChild(none);
    } else if (!isBulkMode) {
      submissions.forEach(s => {
        const si = document.createElement('div');
        si.className = 'submission';

        // Check if the current user is the learner or parent who submitted this
        const isOwner = (identity.role === 'learner' && s.learner === identity.name) ||
                        (identity.role === 'parent' && s.parent === identity.name);
        
        let attachmentInfo = '';
        if (s.attachment) {
          const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(s.attachment);
          const isVideo = /\.(mp4|webm|ogg)$/i.test(s.attachment);

          attachmentInfo = `
            <div class="attachment-tag" style="margin-top: 5px;">
              📎 <a href="/uploads/${escapeHtml(s.attachment)}" target="_blank" title="Open file">${escapeHtml(s.attachment)}</a>
              ${isOwner ? `
                <button type="button" 
                        class="delete-attachment-btn" 
                        data-assignment-id="${a.id}" 
                        data-submission-id="${s.id}" 
                        style="margin-left: 10px; 
                               background-color: #dc3545; 
                               color: white; 
                               border: none; 
                               padding: 5px 10px; 
                               border-radius: 4px; 
                               cursor: pointer;
                               font-size: 0.8em;">Delete Attachment</button>
              ` : ''}

              ${isImage ? `<div class="attachment-preview" style="margin-top: 8px;"><img src="/uploads/${escapeHtml(s.attachment)}" style="max-width: 250px; max-height: 200px; display: block; border: 1px solid #ddd; border-radius: 4px; box-shadow: 2px 2px 5px rgba(0,0,0,0.1);"></div>` : ''}
              ${isVideo ? `<div class="attachment-preview" style="margin-top: 8px;"><video src="/uploads/${escapeHtml(s.attachment)}" controls style="max-width: 320px; display: block; border: 1px solid #ddd; border-radius: 4px;"></video></div>` : ''}
            </div>`;
        }

        let gradeInfo = '';
        if (s.grade) {
          gradeInfo = `
            <div class="grade-info" style="margin-top: 12px; padding: 12px; border-left: 5px solid #28a745; background: #e9f7ef; border-radius: 4px; color: #155724; font-size: 1rem; line-height: 1.5;">
              <div style="margin-bottom: 4px;"><strong>Grade:</strong> <span style="font-size: 1.2rem; color: #1e7e34; font-weight: bold;">${escapeHtml(s.grade)}</span></div>
              ${s.recommendation ? `<div style="margin-top: 8px;"><strong>Teacher Recommendation:</strong><br><span style="display: block; margin-top: 4px; color: #1e4d2b;">${escapeHtml(s.recommendation)}</span></div>` : ''}
              <div style="font-size: 0.8rem; color: #555; margin-top: 8px; border-top: 1px solid #c3e6cb; padding-top: 6px;">
                Graded by <strong>${escapeHtml(s.gradedBy)}</strong> on ${escapeHtml(new Date(s.gradedAt).toLocaleString())}
              </div>
            </div>`;
        }

        let gradingForm = '';
        if (isStaff) {
          gradingForm = `
            <div class="grading-form" style="margin-top: 10px; padding: 10px; background: #fdfdfd; border: 1px dashed #ccc; border-radius: 4px;">
              <input type="text" class="grade-input" placeholder="Enter Grade (e.g. A, Excellent)" value="" style="width: 150px; margin-bottom: 5px; display: block;">
              <textarea class="recommendation-input" placeholder="Enter Recommendation (optional)" style="width: 100%; height: 50px; margin-bottom: 5px; display: block;"></textarea>
              <button type="button" class="save-grade-btn" data-assignment-id="${a.id}" data-submission-id="${s.id}" style="font-size: 0.8em; background: #28a745; color: white; border: none; padding: 5px 12px; border-radius: 4px; cursor: pointer;">Save Grade & Feedback</button>
            </div>`;
        }

        si.innerHTML = `
          <em>${escapeHtml(s.learner)}</em> ${escapeHtml(s.parent ? ' (helped by ' + s.parent + ')' : '')}
          <div class="submission-body" style="margin: 5px 0;">
            <div class="content-text">${escapeHtml(s.content)}</div>
          </div>
          ${attachmentInfo}
          ${gradeInfo}
          <span class="time">${escapeHtml(s.time)}${s.updatedAt ? ' (edited)' : ''}</span>
          ${isOwner ? `
            <div style="margin-top:5px; display: flex; gap: 5px;">
              <button type="button" class="edit-submission-btn" data-assignment-id="${a.id}" data-submission-id="${s.id}" style="font-size:0.75em; padding:2px 8px;">Edit Content</button>
              <button type="button" class="delete-submission-btn" data-assignment-id="${a.id}" data-submission-id="${s.id}" style="font-size:0.75em; padding:2px 8px; background-color: #dc3545; color: white; border: none; border-radius: 3px; cursor: pointer;">Delete Submission</button>
            </div>` : ''}
          ${gradingForm}
        `;
        ul.appendChild(si);
      });
    }
    d.appendChild(ul);

    if (identity.role === 'learner' || identity.role === 'parent') {
      const form = document.createElement('form');
      form.enctype = 'multipart/form-data'; // Important for file uploads
      const learnerInput = identity.role === 'parent' ? '<input type="text" name="learner" placeholder="Learner name" required style="margin-bottom:5px">' : '';
      form.innerHTML = `
        ${learnerInput}
        <textarea name="content" placeholder="Type your answer here..." required style="width:100%; margin-bottom:5px"></textarea>
        <div style="display:flex; gap:10px; align-items:center; margin-bottom:5px">
          <label style="font-size:0.8em">Upload work: <input type="file" name="fileUpload"></label>
        </div>
        <button type="submit">Submit Answer</button>
        <button type="button" class="clear-btn" style="background:#666; margin-left:5px">Clear</button>
      `;

      form.querySelector('.clear-btn').addEventListener('click', () => form.reset());

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.currentTarget;
        const contentTextarea = f.querySelector('textarea[name="content"]');
        const content = (contentTextarea ? contentTextarea.value : '').trim();

        const fileInput = f.querySelector('input[name="fileUpload"]');
        const file = fileInput && fileInput.files[0];
        
        const formData = new FormData();
        formData.append('content', content);
        if (file) {
          formData.append('fileUpload', file); // 'fileUpload' matches the name attribute in the input
        }

        if (identity.role === 'parent') {
          const learnerInput = f.querySelector('input[name="learner"]');
          const learnerName = (learnerInput ? learnerInput.value : '').trim();
          formData.append('learner', learnerName);
        }

        // Simulated email functionality
        const emailSummary = file
          ? `Content and file "${file.name}"`
          : `Content`;
        console.log(`Emailing ${a.teacher}... ${emailSummary} sent successfully.`);
        alert(`Sent to ${a.teacher}'s email: ${emailSummary}`);
        const response = await authFetch(`/api/assignments/${a.id}/submit`, { method: 'POST', body: formData }); // No Content-Type header needed for FormData
        if (!response.ok) {
          const error = await response.json();
          return alert(error.error || 'Failed to submit');
        }
        form.reset();
        await refresh();
      });
      d.appendChild(form);
    }

    // Add event listeners for delete buttons after all submissions are rendered
    ul.querySelectorAll('.delete-attachment-btn').forEach(button => {
      button.addEventListener('click', async (e) => {
        const assignmentId = e.target.dataset.assignmentId;
        const submissionId = e.target.dataset.submissionId;
        if (confirm('Are you sure you want to delete this attachment? This action cannot be undone.')) {
          try {
            const response = await authFetch(`/api/assignments/${assignmentId}/submissions/${submissionId}/attachment`, {
              method: 'DELETE'
            });
            if (!response.ok) {
              const error = await response.json();
              throw new Error(error.error || 'Failed to delete attachment');
            }
            alert('Attachment deleted successfully!');
            refresh(); // Re-render assignments
          } catch (error) {
            alert(`Error: ${error.message}`);
            console.error('Error deleting attachment:', error);
          }
        }
      });
    });

    // Add event listeners for delete submission buttons
    ul.querySelectorAll('.delete-submission-btn').forEach(button => {
      button.addEventListener('click', async (e) => {
        const assignmentId = e.target.dataset.assignmentId;
        const submissionId = e.target.dataset.submissionId;
        if (confirm('Are you sure you want to delete this entire submission? This action cannot be undone.')) {
          try {
            const response = await authFetch(`/api/assignments/${assignmentId}/submissions/${submissionId}`, {
              method: 'DELETE'
            });
            if (!response.ok) {
              const error = await response.json();
              throw new Error(error.error || 'Failed to delete submission');
            }
            refresh();
          } catch (error) {
            alert(`Error: ${error.message}`);
          }
        }
      });
    });

    // Add event listeners for edit buttons
    ul.querySelectorAll('.edit-submission-btn').forEach(button => {
      button.addEventListener('click', (e) => {
        const assignmentId = e.target.dataset.assignmentId;
        const submissionId = e.target.dataset.submissionId;
        const si = e.target.closest('.submission');
        const body = si.querySelector('.submission-body');
        const currentText = body.querySelector('.content-text').textContent;

        // Replace text with editor
        body.innerHTML = `
          <textarea class="edit-content-input" style="width:100%; min-height:60px; margin-top:5px;">${escapeHtml(currentText)}</textarea>
          <div style="margin-top:5px;">
            <button type="button" class="save-edit-btn" style="background:#28a745; color:white; border:none; padding:4px 10px; border-radius:4px; cursor:pointer;">Save</button>
            <button type="button" class="cancel-edit-btn" style="background:#666; color:white; border:none; padding:4px 10px; border-radius:4px; margin-left:5px; cursor:pointer;">Cancel</button>
          </div>
        `;

        body.querySelector('.cancel-edit-btn').onclick = () => {
          body.innerHTML = `<div class="content-text">${escapeHtml(currentText)}</div>`;
        };
        
        body.querySelector('.save-edit-btn').onclick = async () => {
          const newContent = body.querySelector('.edit-content-input').value.trim();
          if (!newContent) return alert('Content cannot be empty');
          
          try {
            const response = await authFetch(`/api/assignments/${assignmentId}/submissions/${submissionId}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: newContent })
            });
            
            if (!response.ok) throw new Error('Failed to update submission');
            
            body.innerHTML = `<div class="content-text">${escapeHtml(newContent)}</div>`;
            refresh();
          } catch (err) {
            alert(err.message);
          }
        };
      });
    });

    // Add event listeners for grading buttons
    ul.querySelectorAll('.save-grade-btn').forEach(button => {
      button.addEventListener('click', async (e) => {
        const assignmentId = e.target.dataset.assignmentId;
        const submissionId = e.target.dataset.submissionId;
        const form = e.target.closest('.grading-form');
        const grade = form.querySelector('.grade-input').value.trim();
        const recommendation = form.querySelector('.recommendation-input').value.trim();
        if (!grade) return alert('Please enter a grade before saving.');
        try {
          const response = await authFetch(`/api/assignments/${assignmentId}/submissions/${submissionId}/grade`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grade, recommendation })
          });
          if (!response.ok) throw new Error('Failed to save grade');
          

          // Clear the fields immediately
          form.querySelector('.grade-input').value = '';
          form.querySelector('.recommendation-input').value = '';
          
          refresh();
        } catch (err) {
          alert(err.message);
        }
      });
    });

    el.appendChild(d);
  });
}

async function initTeacherHub() {
  if ($('teacherHubSection')) {
    refreshTeacherHub();
    return;
  }

  const container = document.createElement('div');
  container.id = 'teacherHubSection';
  container.className = 'section staff-only';
  container.innerHTML = `
    <div style="background:#f8f9fa; border-radius:12px; padding:20px; border:1px solid #dee2e6;">
      <div style="display:flex; gap:20px; margin-bottom:20px; border-bottom:2px solid #eee; padding-bottom:10px;">
        <button id="tabAttendance" style="background:none; border:none; font-weight:bold; cursor:pointer; color:#007bff;">Attendance Management</button>
        <button id="tabGradebook" style="background:none; border:none; font-weight:bold; cursor:pointer; color:#666;">Global Marksheet</button>
      </div>

      <div id="attendanceContent">
        <div class="header-row" style="margin-bottom:15px;">
          <h2 style="margin:0;">Mark Attendance</h2>
          <div style="display:flex; gap:10px; align-items:center;">
             <input type="date" id="attendanceDate" value="${new Date().toISOString().split('T')[0]}" style="padding:5px;">
             <button id="markAllPresent" style="font-size:0.8em; background:#6c757d; color:white; border:none; padding:5px 10px; border-radius:4px;">Mark All Present</button>
          </div>
        </div>
        <div id="attendanceList" style="background:white; border-radius:8px; overflow:hidden;"></div>
        <button id="saveAttendanceBtn" style="margin-top:15px; width:100%; background:#28a745; color:white; border:none; padding:12px; border-radius:6px; font-weight:bold; cursor:pointer;">Save Attendance Records</button>
      </div>

      <div id="gradebookContent" class="hidden">
        <h2 style="margin-top:0;">Global Gradebook</h2>
        <div id="gradebookTable" style="overflow-x:auto;"></div>
      </div>
    </div>
  `;
  $('appScreen').appendChild(container);

  $('tabAttendance').onclick = () => {
    $('attendanceContent').classList.remove('hidden');
    $('gradebookContent').classList.add('hidden');
    $('tabAttendance').style.color = '#007bff';
    $('tabGradebook').style.color = '#666';
  };
  $('tabGradebook').onclick = () => {
    $('attendanceContent').classList.add('hidden');
    $('gradebookContent').classList.remove('hidden');
    $('tabAttendance').style.color = '#666';
    $('tabGradebook').style.color = '#007bff';
    refreshGradebook();
  };

  $('attendanceDate').addEventListener('change', refreshTeacherHub);
  $('markAllPresent').onclick = () => {
    document.querySelectorAll('.att-status').forEach(sel => sel.value = 'present');
  };

  $('saveAttendanceBtn').addEventListener('click', async () => {
    const btn = $('saveAttendanceBtn');
    const date = $('attendanceDate').value;
    const records = {};
    document.querySelectorAll('.att-status').forEach(sel => {
      records[sel.dataset.name] = sel.value;
    });
    
    if (Object.keys(records).length === 0) return alert('No learners to mark attendance for.');

    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
      const res = await authFetch('/api/attendance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, records })
      });
      const data = await res.json();
      if (res.ok) alert('Attendance saved successfully for ' + date);
      else throw new Error(data.error || 'Failed to save attendance');
    } catch (err) { alert(err.message); }
    finally {
      btn.disabled = false;
      btn.textContent = 'Save Attendance';
    }
  });

  refreshTeacherHub();
}

async function refreshTeacherHub() {
  const list = $('attendanceList');
  const date = $('attendanceDate').value;
  if (!list) return;

  try {
    const [learners, records] = await Promise.all([
      authFetch('/api/learners').then(r => r.json()),
      authFetch(`/api/attendance/${date}`).then(r => r.json())
    ]);
    
    list.innerHTML = '';
    if (!learners.length) {
      list.innerHTML = '<div style="padding:20px; text-align:center; color:#666;">No students found with submissions.</div>';
      return;
    }

    learners.forEach(l => {
      const status = records[l.name] || 'absent';
      const row = document.createElement('div');
      row.style = "display:flex; justify-content:space-between; align-items:center; padding:12px 20px; border-bottom:1px solid #eee;";
      row.innerHTML = `
        <strong>${escapeHtml(l.name)}</strong>
        <select class="att-status" data-name="${escapeHtml(l.name)}" style="padding:5px; border-radius:4px; border:1px solid #ccc;">
          <option value="present" ${status === 'present' ? 'selected' : ''}>Present</option>
          <option value="absent" ${status === 'absent' ? 'selected' : ''}>Absent</option>
        </select>
      `;
      list.appendChild(row);
    });
  } catch (err) { console.warn('Attendance refresh failed', err); }
}

async function refreshGradebook() {
  const tableDiv = $('gradebookTable');
  if (!tableDiv) return;
  try {
    const report = await authFetch('/api/gradebook').then(r => r.json());
    let html = `<table style="width:100%; border-collapse:collapse; background:white; border-radius:8px; overflow:hidden;">
      <thead><tr style="background:#eee; text-align:left;">
        <th style="padding:10px; border:1px solid #ddd;">Assignment</th>
        <th style="padding:10px; border:1px solid #ddd;">Learner</th>
        <th style="padding:10px; border:1px solid #ddd;">Grade</th>
      </tr></thead><tbody>`;
    
    report.forEach(a => {
      if (a.grades.length === 0) {
        html += `<tr><td style="padding:10px; border:1px solid #ddd;">${escapeHtml(a.title)}</td><td colspan="2" style="padding:10px; border:1px solid #ddd; color:#999; font-style:italic;">No submissions</td></tr>`;
      } else {
        a.grades.forEach((g, idx) => {
          html += `<tr>
            ${idx === 0 ? `<td rowspan="${a.grades.length}" style="padding:10px; border:1px solid #ddd; vertical-align:top; font-weight:bold;">${escapeHtml(a.title)}</td>` : ''}
            <td style="padding:10px; border:1px solid #ddd;">${escapeHtml(g.learner)}</td>
            <td style="padding:10px; border:1px solid #ddd;"><span style="background:#e9ecef; padding:2px 8px; border-radius:4px;">${escapeHtml(g.grade)}</span></td>
          </tr>`;
        });
      }
    });
    html += '</tbody></table>';
    tableDiv.innerHTML = html;
  } catch (err) { tableDiv.innerHTML = 'Error loading gradebook.'; }
}

function renderAdminUsers(users) {
  const el = $('userList');
  el.innerHTML = '';
  users.forEach(user => { // Assuming user object now contains firstName, lastName, otherName
    const card = document.createElement('div');
    card.className = 'user-card';
    card.innerHTML = `<strong>${escapeHtml(user.name)}</strong> <span>${escapeHtml(user.role)}</span><div>${escapeHtml(user.email)}</div>`;
    el.appendChild(card);
  });
}

function renderEmbeddingSearchResults(results) {
  const el = $('searchResults');
  el.innerHTML = '';
  if (!results || !results.length) {
    el.innerHTML = '<p>No matching indexed content found.</p>';
    return;
  }
  results.forEach(item => {
    const card = document.createElement('div');
    card.className = 'search-result';
    card.innerHTML = `<h3>${escapeHtml(item.sourceType || 'Indexed item')}</h3><p>${escapeHtml(item.text)}</p><small>Source ID: ${escapeHtml(String(item.sourceId || 'n/a'))} • Score: ${escapeHtml(item.score.toFixed(3))}</small>`;
    el.appendChild(card);
  });
}

async function refreshAdmin() {
  try {
    const [summary, users] = await Promise.all([fetchAdminSummary(), fetchAdminUsers()]);
    $('adminUsersCount').textContent = summary.totalUsers;
    $('adminMessagesCount').textContent = summary.totalMessages;
    $('adminAssignmentsCount').textContent = summary.totalAssignments;
    renderAdminUsers(users);
  } catch (err) {
    console.warn('Admin refresh failed', err);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function setFormStatus(id, message, isError = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = message;
  el.style.color = isError ? '#ff8a8a' : '#8ce7ff';
}

function toggleButton(button, enabled) {
  if (!button) return;
  button.disabled = !enabled;
  button.style.opacity = enabled ? '1' : '0.6';
}

async function sendMessage(text, to, parentId) {
  const payload = { text, to };
  if (parentId) payload.parentId = parentId;
  const res = await authFetch('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Send failed');
  seenMessageIds.add(data.id);
  return data;
}

async function resolveMessage(messageId, resolved) {
  const res = await authFetch(`/api/messages/${messageId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolved })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Resolve failed');
  return data;
}

function buildMessageTree(messages) {
  const nodes = new Map();
  messages.forEach(msg => {
    nodes.set(msg.id, { ...msg, replies: [] });
  });
  const roots = [];
  nodes.forEach(msg => {
    if (msg.parentId) {
      const parent = nodes.get(Number(msg.parentId));
      if (parent) parent.replies.push(msg);
      else roots.push(msg);
    } else {
      roots.push(msg);
    }
  });
  const sortByTime = (a, b) => new Date(a.time) - new Date(b.time);
  const sortTree = (list) => {
    list.sort(sortByTime);
    list.forEach(item => sortTree(item.replies));
  };
  sortTree(roots);
  return roots;
}

function renderMessageNode(msg, level = 0) {
  const d = document.createElement('div');
  d.className = 'message';
  if (level > 0) d.classList.add('threaded');
  d.style.marginLeft = `${level * 18}px`;
  const isUnread = identity && !seenMessageIds.has(msg.id) && msg.from !== identity.name; // identity.name is the full name
  if (isUnread) d.classList.add('unread');
  d.innerHTML = `<strong>${escapeHtml(msg.from)} (${escapeHtml(msg.role)})</strong> ${msg.to ? '<em>to ' + escapeHtml(msg.to) + '</em>' : ''}<div>${escapeHtml(msg.text)}</div><span class="time">${escapeHtml(msg.time)}</span>`;
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const replyButton = document.createElement('button');
  replyButton.className = 'reply-button';
  replyButton.type = 'button';
  replyButton.textContent = 'Reply';
  actions.appendChild(replyButton);

  if (identity && (identity.role === 'teacher' || identity.role === 'admin')) {
    const resolveButton = document.createElement('button');
    resolveButton.className = 'reply-button';
    resolveButton.type = 'button';
    resolveButton.textContent = msg.resolved ? 'Unresolve' : 'Resolve';
    actions.appendChild(resolveButton);
    resolveButton.addEventListener('click', async () => {
      resolveButton.disabled = true;
      try {
        const updated = await resolveMessage(msg.id, !msg.resolved);
        const index = currentMessages.findIndex(m => m.id === updated.id);
        if (index !== -1) currentMessages[index] = updated;
        renderMessages(currentMessages);
      } catch (err) {
        console.warn('Resolve failed', err);
      } finally {
        resolveButton.disabled = false;
      }
    });

  // Add Recipient Selector to Assignment Form
  const assignForm = $('assignmentForm');
  if (assignForm) {
    const label = document.createElement('label');
    label.style = 'display:block; margin-bottom:10px; font-size:0.9em;';
    label.innerHTML = `Target Learners: 
      <select id="assignmentTarget" style="width:100%; margin-top:5px; padding:8px;">
        <option value="All Learners">All Learners</option>
        <option value="Group A">Group A</option>
        <option value="Group B">Group B</option>
      </select>`;
    assignForm.insertBefore(label, $('assignmentDesc').nextSibling);
  }
  }

  d.appendChild(actions);

  if (msg.resolved) {
    const resolvedTag = document.createElement('div');
    resolvedTag.className = 'resolved-tag';
    resolvedTag.textContent = `Resolved by ${msg.resolvedBy || 'unknown'}`;
    d.appendChild(resolvedTag);
  }

  d.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    if (seenMessageIds.has(msg.id)) return;
    seenMessageIds.add(msg.id);
    if (msg.from !== identity.name && unreadCount > 0) {
      unreadCount -= 1;
      updateUnreadBadge();
    }
    d.classList.remove('unread');
  });

  let replyForm = null;
  replyButton.addEventListener('click', () => {
    if (replyForm) {
      replyForm.remove();
      replyForm = null;
      return;
    }
    replyForm = document.createElement('div');
    replyForm.className = 'reply-form';
    replyForm.innerHTML = `<input class="replyContent" placeholder="Write a reply" /><button type="button">Send</button>`;
    const input = replyForm.querySelector('.replyContent');
    const button = replyForm.querySelector('button');
    button.addEventListener('click', async () => {
      const content = input.value.trim();
      if (!content) return alert('Enter a reply');
      button.disabled = true;
      await sendMessage(content, null, msg.id);
      replyForm.remove();
      replyForm = null;
      refresh();
    });
    d.appendChild(replyForm);
    input.focus();
  });

  if (msg.replies && msg.replies.length) {
    const thread = document.createElement('div');
    thread.className = 'thread';
    msg.replies.forEach(reply => {
      thread.appendChild(renderMessageNode(reply, level + 1));
    });
    d.appendChild(thread);
  }
  return d;
}

async function createAssignment(title, desc) {
  const res = await authFetch('/api/assignments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, description: desc })
  });
  return await res.json();
}

async function indexText(text, sourceType, sourceId) {
  try {
    const r = await authFetch('/api/embeddings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sourceType, sourceId })
    });
    if (!r.ok) {
      const e = await r.json();
      console.warn('Indexing failed', e);
    } else {
      return await r.json();
    }
  } catch (err) {
    console.warn('Indexing error', err);
  }
}

async function refresh() {
  if (!identity) return;
  const [msgs, assigns] = await Promise.all([fetchMessages(), fetchAssignments()]);
  currentMessages = msgs || [];
  currentMessages.forEach(msg => seenMessageIds.add(msg.id));
  unreadCount = 0;
  updateUnreadBadge();
  renderMessages(currentMessages);
  renderAssignments(assigns);
  refreshAttendance();
}

function setMessageFilter(filter) {
  messageFilter = filter;
  ['filterAll', 'filterUnread', 'filterUnresolved', 'filterResolved'].forEach(id => {
    const button = $(id);
    if (!button) return;
    button.classList.toggle('active', id === `filter${filter.charAt(0).toUpperCase() + filter.slice(1)}`);
  });
  renderMessages(currentMessages);
}

document.addEventListener('DOMContentLoaded', () => {
  $('authForm').addEventListener('submit', loginUser);
  $('authToggleLink').addEventListener('click', (e) => {
    e.preventDefault();
    setAuthMode(authMode === 'login' ? 'signup' : 'login');
  });
  $('forgotPasswordLink').addEventListener('click', (e) => {
    e.preventDefault();
    setAuthMode('forgot');
  });
  $('logoutButton').addEventListener('click', logoutUser);
  if ($('filterAll')) {
    $('filterAll').addEventListener('click', () => setMessageFilter('all'));
    $('filterUnread').addEventListener('click', () => setMessageFilter('unread'));
    $('filterUnresolved').addEventListener('click', () => setMessageFilter('unresolved'));
    $('filterResolved').addEventListener('click', () => setMessageFilter('resolved'));
  }

  $('submissionSearch').addEventListener('input', (e) => {
    submissionSearchQuery = e.target.value;
    refresh(); // Re-render assignments with the filter applied
  });
  
  $('searchButton').addEventListener('click', () => {
    submissionSearchQuery = $('submissionSearch').value;
    refresh();
  });

  $('messageForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('messageText').value.trim();
    const to = $('messageTo').value.trim();
    if (!text) return;
    const statusId = 'messageStatus';
    const button = $('messageForm').querySelector('button');
    setFormStatus(statusId, 'Saving message...');
    toggleButton(button, false);
    try {
      const msg = await sendMessage(text, to || null);
      $('messageText').value = '';
      $('messageTo').value = '';
      const shouldIndex = $('indexMessage').checked;
      if (shouldIndex && msg && msg.id) {
        await indexText(msg.text || text, 'message', msg.id);
      }
      setFormStatus(statusId, 'Message saved.');
      await refresh();
      const msgList = $('messages');
      msgList.scrollTop = msgList.scrollHeight; // Auto-scroll for chat feel
    } catch (err) {
      setFormStatus(statusId, 'Unable to save message.', true);
      console.warn(err);
    } finally {
      toggleButton(button, true);
      setTimeout(() => setFormStatus(statusId, ''), 2500);
    }
  });

  $('assignmentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('assignmentTitle').value.trim();
    const desc = $('assignmentDesc').value.trim();
    if (!title) return alert('Enter title');
    const statusId = 'assignmentStatus';
    const button = $('assignmentForm').querySelector('button');
    setFormStatus(statusId, 'Saving assignment...');
    toggleButton(button, false);
    try {
      const a = await createAssignment(title, desc);
      const shouldIndex = $('indexAssignment').checked;
      if (shouldIndex && a && a.id) {
        await indexText(`${a.title}\n\n${a.description || ''}`, 'assignment', a.id);
      }
      $('assignmentTitle').value = '';
      $('assignmentDesc').value = '';
      setFormStatus(statusId, 'Assignment saved.');
      await refresh();
    } catch (err) {
      setFormStatus(statusId, 'Unable to save assignment.', true);
      console.warn(err);
    } finally {
      toggleButton(button, true);
      setTimeout(() => setFormStatus(statusId, ''), 2500);
    }
  });

  $('embeddingSearchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = $('searchQuery').value.trim();
    if (!query) return alert('Enter a search query');
    try {
      const results = await fetchSearchEmbeddings(query);
      renderEmbeddingSearchResults(results);
    } catch (err) {
      alert(err.message);
    }
  });

  setAuthMode('login');
  restoreSession();
});
