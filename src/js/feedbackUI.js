import { getUser, getToken, isLoggedIn } from './auth.js';
import { showToast } from './guildUI.js';

const getE = (id) => document.getElementById(id);

let selectedType = 'bug';

function openFeedbackModal() {
  if (!isLoggedIn()) {
    showToast('You must be logged in to send feedback.', 'error');
    return;
  }

  const modal = getE('feedbackModal');
  if (!modal) return;

  // Reset to form state
  getE('feedbackSuccess').style.display = 'none';
  getE('feedbackFormBody').style.display = 'block';
  getE('feedbackError').style.display = 'none';
  getE('feedbackError').textContent = '';
  getE('feedbackSubject').value = '';
  getE('feedbackDescription').value = '';
  getE('feedbackDescCount').textContent = '0 / 2000';

  // Reset type pill to bug
  selectedType = 'bug';
  document.querySelectorAll('.feedback-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === 'bug');
  });

  modal.style.display = 'flex';
  getE('feedbackSubject').focus();
}

function closeFeedbackModal() {
  const modal = getE('feedbackModal');
  if (modal) modal.style.display = 'none';
}

function clientSpamCheck(text) {
  if (/(.)\1{4,}/.test(text)) return 'Please avoid repeating the same character.';
  const alpha = text.replace(/[^a-zA-Z]/g, '');
  if (alpha.length >= 15 && (alpha.replace(/[^A-Z]/g, '').length / alpha.length) > 0.65) {
    return 'Please avoid using excessive capital letters.';
  }
  return null;
}

async function submitFeedback() {
  if (!isLoggedIn()) {
    showToast('You must be logged in to send feedback.', 'error');
    closeFeedbackModal();
    return;
  }

  const subject = getE('feedbackSubject').value.trim();
  const description = getE('feedbackDescription').value.trim();
  const errorEl = getE('feedbackError');
  const submitBtn = getE('btnFeedbackSubmit');

  errorEl.style.display = 'none';

  if (subject.length < 3) {
    errorEl.textContent = 'Subject must be at least 3 characters.';
    errorEl.style.display = 'block';
    return;
  }
  if (description.length < 10) {
    errorEl.textContent = 'Description must be at least 10 characters.';
    errorEl.style.display = 'block';
    return;
  }

  const spamError = clientSpamCheck(subject) || clientSpamCheck(description);
  if (spamError) {
    errorEl.textContent = spamError;
    errorEl.style.display = 'block';
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending...';

  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`,
      },
      body: JSON.stringify({ type: selectedType, subject, description }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send.');

    getE('feedbackFormBody').style.display = 'none';
    getE('feedbackSuccess').style.display = 'block';
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Send Report →';
  }
}

export function initFeedbackUI() {
  // Type pill selection
  document.querySelectorAll('.feedback-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedType = btn.dataset.type;
      document.querySelectorAll('.feedback-type-btn').forEach(b =>
        b.classList.toggle('active', b === btn)
      );
    });
  });

  // Description char counter
  getE('feedbackDescription')?.addEventListener('input', (e) => {
    getE('feedbackDescCount').textContent = `${e.target.value.length} / 2000`;
  });

  // Focus ring highlight
  ['feedbackSubject', 'feedbackDescription'].forEach(id => {
    const el = getE(id);
    if (!el) return;
    el.addEventListener('focus', () => { el.style.borderColor = 'rgba(255,193,7,0.4)'; });
    el.addEventListener('blur',  () => { el.style.borderColor = 'rgba(255,255,255,0.1)'; });
  });

  getE('btnCloseFeedback')?.addEventListener('click', closeFeedbackModal);
  getE('btnFeedbackCancel')?.addEventListener('click', closeFeedbackModal);
  getE('btnFeedbackDone')?.addEventListener('click', closeFeedbackModal);
  getE('btnFeedbackSubmit')?.addEventListener('click', submitFeedback);

  getE('feedbackModal')?.addEventListener('click', (e) => {
    if (e.target === getE('feedbackModal')) closeFeedbackModal();
  });

  getE('linkFeedback')?.addEventListener('click', (e) => {
    e.preventDefault();
    openFeedbackModal();
  });

  window.openFeedbackModal = openFeedbackModal;
}
