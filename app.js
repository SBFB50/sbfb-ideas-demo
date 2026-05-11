// SPDX-License-Identifier: AGPL-3.0-or-later

(function () {
  "use strict";

  var myPubkey = null;
  var currentSort = "votes";
  var ideas = [];
  var votes = {};

  var dotEl = document.getElementById("identity-dot");
  var keyEl = document.getElementById("identity-key");
  var formEl = document.getElementById("idea-form");
  var titleEl = document.getElementById("idea-title");
  var descEl = document.getElementById("idea-desc");
  var submitBtn = document.getElementById("submit-btn");
  var listEl = document.getElementById("ideas-list");
  var countEl = document.getElementById("ideas-count");
  var sortVotesBtn = document.getElementById("sort-votes");
  var sortRecentBtn = document.getElementById("sort-recent");

  var bridge = null;
  try {
    bridge = new SBFBBridge({ timeout: 5000 });
  } catch (e) {
    setOffline();
    return;
  }

  function setOnline(pubkey) {
    dotEl.className = "identity-dot online";
    keyEl.textContent = truncateId(pubkey);
    keyEl.title = pubkey;
  }

  function setOffline() {
    dotEl.className = "identity-dot offline";
    keyEl.textContent = "Hors ligne";
    submitBtn.disabled = true;
  }

  function truncateId(id) {
    if (!id) return "";
    if (id.length <= 16) return id;
    return id.slice(0, 8) + "…" + id.slice(-8);
  }

  function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function formatDate(iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso);
      return d.toLocaleDateString("fr-FR", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    } catch (e) {
      return "";
    }
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // --- Data operations ---

  function loadAll() {
    return Promise.all([
      bridge.listStorage("ideas/").catch(function () {
        return { entries: [] };
      }),
      bridge.listStorage("votes/").catch(function () {
        return { entries: [] };
      }),
    ]).then(function (results) {
      var ideaEntries = results[0].entries || [];
      var voteEntries = results[1].entries || [];

      votes = {};
      for (var i = 0; i < voteEntries.length; i++) {
        var vk = voteEntries[i].key;
        var parts = vk.split("/");
        if (parts.length >= 3) {
          var ideaId = parts[1];
          if (!votes[ideaId]) votes[ideaId] = {};
          votes[ideaId][parts[2]] = true;
        }
      }

      ideas = [];
      for (var j = 0; j < ideaEntries.length; j++) {
        var entry = ideaEntries[j];
        var val = entry.value || entry;
        var id = entry.key ? entry.key.replace("ideas/", "") : val.id;
        var votesForIdea = votes[id] || {};
        var votesCount = Object.keys(votesForIdea).length;

        ideas.push({
          id: id,
          title: val.title || "",
          description: val.description || "",
          author: val.author || "",
          created_at: val.created_at || "",
          votes_count: votesCount,
        });
      }

      render();
    });
  }

  function submitIdea(title, description) {
    var id = uuid();
    var data = {
      title: title,
      description: description,
      author: myPubkey,
      created_at: new Date().toISOString(),
    };
    return bridge.setStorage("ideas/" + id, data).then(function () {
      return loadAll();
    });
  }

  function toggleVote(ideaId) {
    if (!myPubkey) return Promise.resolve();
    var ideaVotes = votes[ideaId] || {};
    var hasVoted = !!ideaVotes[myPubkey];

    if (hasVoted) {
      return bridge.deleteStorage("votes/" + ideaId + "/" + myPubkey).then(function () {
        return loadAll();
      });
    } else {
      return bridge
        .setStorage("votes/" + ideaId + "/" + myPubkey, {
          timestamp: new Date().toISOString(),
        })
        .then(function () {
          return loadAll();
        });
    }
  }

  function deleteIdea(ideaId) {
    var ideaVotes = votes[ideaId] || {};
    var voterKeys = Object.keys(ideaVotes);
    var deletions = [bridge.deleteStorage("ideas/" + ideaId)];
    for (var i = 0; i < voterKeys.length; i++) {
      deletions.push(bridge.deleteStorage("votes/" + ideaId + "/" + voterKeys[i]));
    }
    return Promise.all(deletions).then(function () {
      return loadAll();
    });
  }

  // --- Rendering ---

  function sortIdeas(list) {
    var sorted = list.slice();
    if (currentSort === "votes") {
      sorted.sort(function (a, b) {
        if (b.votes_count !== a.votes_count) return b.votes_count - a.votes_count;
        return (b.created_at || "").localeCompare(a.created_at || "");
      });
    } else {
      sorted.sort(function (a, b) {
        return (b.created_at || "").localeCompare(a.created_at || "");
      });
    }
    return sorted;
  }

  function render() {
    var sorted = sortIdeas(ideas);
    countEl.textContent = "(" + ideas.length + ")";

    if (sorted.length === 0) {
      listEl.innerHTML = '<p class="placeholder">Aucune idée pour le moment. Soyez le premier !</p>';
      return;
    }

    listEl.innerHTML = "";
    for (var i = 0; i < sorted.length; i++) {
      listEl.appendChild(createIdeaCard(sorted[i]));
    }
  }

  function createIdeaCard(idea) {
    var card = document.createElement("article");
    card.className = "idea-card";

    var ideaVotes = votes[idea.id] || {};
    var hasVoted = myPubkey ? !!ideaVotes[myPubkey] : false;
    var isAuthor = myPubkey && idea.author === myPubkey;

    var voteArea = document.createElement("div");
    voteArea.className = "vote-area";

    var voteBtn = document.createElement("button");
    voteBtn.className = "vote-btn" + (hasVoted ? " voted" : "");
    voteBtn.textContent = "▲";
    voteBtn.title = hasVoted ? "Retirer le vote" : "Voter pour cette idée";
    voteBtn.disabled = !myPubkey;
    voteBtn.addEventListener("click", function () {
      voteBtn.disabled = true;
      toggleVote(idea.id).catch(function () {
        voteBtn.disabled = false;
      });
    });

    var voteCount = document.createElement("span");
    voteCount.className = "vote-count";
    voteCount.textContent = String(idea.votes_count);

    voteArea.appendChild(voteBtn);
    voteArea.appendChild(voteCount);

    var body = document.createElement("div");
    body.className = "idea-body";

    var titleDiv = document.createElement("div");
    titleDiv.className = "idea-title";
    titleDiv.textContent = idea.title;

    body.appendChild(titleDiv);

    if (idea.description) {
      var descDiv = document.createElement("div");
      descDiv.className = "idea-desc";
      descDiv.textContent = idea.description;
      body.appendChild(descDiv);
    }

    var meta = document.createElement("div");
    meta.className = "idea-meta";

    var authorSpan = document.createElement("span");
    authorSpan.className = "author";
    authorSpan.textContent = truncateId(idea.author);
    authorSpan.title = idea.author || "";

    var dateSpan = document.createElement("span");
    dateSpan.textContent = formatDate(idea.created_at);

    meta.appendChild(authorSpan);
    meta.appendChild(dateSpan);
    body.appendChild(meta);

    if (isAuthor) {
      var actions = document.createElement("div");
      actions.className = "idea-actions";
      var delBtn = document.createElement("button");
      delBtn.className = "delete-btn";
      delBtn.textContent = "Supprimer";
      delBtn.addEventListener("click", function () {
        delBtn.disabled = true;
        deleteIdea(idea.id).catch(function () {
          delBtn.disabled = false;
        });
      });
      actions.appendChild(delBtn);
      body.appendChild(actions);
    }

    card.appendChild(voteArea);
    card.appendChild(body);
    return card;
  }

  // --- Sort controls ---

  sortVotesBtn.addEventListener("click", function () {
    currentSort = "votes";
    sortVotesBtn.classList.add("active");
    sortRecentBtn.classList.remove("active");
    render();
  });

  sortRecentBtn.addEventListener("click", function () {
    currentSort = "recent";
    sortRecentBtn.classList.add("active");
    sortVotesBtn.classList.remove("active");
    render();
  });

  // --- Form submit ---

  submitBtn.addEventListener("click", function () {
    var title = titleEl.value.trim();
    if (!title) return;
    var desc = descEl.value.trim();

    submitBtn.disabled = true;
    submitIdea(title, desc)
      .then(function () {
        titleEl.value = "";
        descEl.value = "";
        submitBtn.disabled = false;
        titleEl.focus();
      })
      .catch(function () {
        submitBtn.disabled = false;
      });
  });

  // --- Live sync (Sprint 58 Phase D) ---

  var syncEl = document.getElementById("sync-status");

  function updateSyncIndicator() {
    if (syncEl) {
      var now = new Date();
      syncEl.textContent =
        "Dernière sync : " +
        now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      syncEl.style.opacity = "1";
      setTimeout(function () {
        syncEl.style.opacity = "0.6";
      }, 1000);
    }
  }

  bridge.onStorageUpdate("sbfb-ideas", function () {
    loadAll().then(updateSyncIndicator);
  });

  // --- Init ---

  bridge
    .getIdentityPubkey()
    .then(function (data) {
      myPubkey = data.pubkey;
      setOnline(myPubkey);
      return loadAll();
    })
    .catch(function () {
      setOffline();
      loadAll();
    });
})();
