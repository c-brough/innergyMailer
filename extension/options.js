/* Options page logic — stores the chosen mail app in chrome.storage.local. */

const DEFAULT_APP = "mail";

function setStatus(text) {
  const el = document.getElementById("status");
  el.textContent = text;
  if (text) setTimeout(() => (el.textContent = ""), 1500);
}

// Load the saved choice and check the matching radio.
chrome.storage.local.get("mailApp", ({ mailApp }) => {
  const value = mailApp || DEFAULT_APP;
  const input = document.querySelector(`input[name="mailApp"][value="${value}"]`);
  if (input) input.checked = true;
});

// Save on change.
document.querySelectorAll('input[name="mailApp"]').forEach((input) => {
  input.addEventListener("change", (e) => {
    chrome.storage.local.set({ mailApp: e.target.value }, () => setStatus("Saved ✓"));
  });
});
