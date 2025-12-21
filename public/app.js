// تطبيق ZZApp - واتساب ويب للهواتف القديمة والزرارية
var socket = io();
var currentChat = null;
var currentChatData = null;
var isRecording = false;
var mediaRecorder = null;
var audioChunks = [];
var recordingTimer = null;
var recordingStartTime = null;
var currentUser = null;
var currentSessionId = null;
var emojiHistory = JSON.parse(localStorage.getItem('emojiHistory')) || [];
var chatsCache = {};
var userAvatarCache = {};

// أحداث السوكيت
socket.on("connect", function() {
  console.log("✅ متصل بالسيرفر");
  
  const savedSession = localStorage.getItem('whatsapp_session');
  if (savedSession) {
    console.log("🔍 محاولة استعادة الجلسة:", savedSession);
    socket.emit("restore_session", savedSession);
    document.getElementById("status").innerHTML = "جارٍ استعادة الجلسة...";
  } else {
    console.log("❌ لا توجد جلسة محفوظة");
    document.getElementById("status").innerHTML = "جارٍ الاتصال...";
  }
  
  showNotification("متصل بالسيرفر", "success");
});

socket.on("waiting", function() {
  console.log("⏳ في انتظار الاتصال");
  document.getElementById("status").innerHTML = "جارٍ الاتصال...";
});

socket.on("qr", function(data) {
  console.log("📱 كود QR متاح");
  showScreen("login");
  document.getElementById("qr").src = data.qr;
  document.getElementById("status").innerHTML = "مسح الكود للدخول";
  
  if (data.sessionId) {
    currentSessionId = data.sessionId;
    localStorage.setItem('whatsapp_session', data.sessionId);
    console.log("💾 تم حفظ الجلسة:", data.sessionId);
  }
});

socket.on("ready", function(data) {
  console.log("🚀 جاهز للاستخدام");
  showScreen("chats");
  
  if (data.sessionId) {
    currentSessionId = data.sessionId;
    localStorage.setItem('whatsapp_session', data.sessionId);
  }
  
  loadChats();
  showNotification("تم الاتصال بواتساب", "success");
});

socket.on("session_restored", function(data) {
  console.log("🔓 تم استعادة الجلسة:", data.sessionId);
  currentSessionId = data.sessionId;
  showScreen("chats");
  loadChats();
  showNotification("تم استعادة الجلسة السابقة", "info");
});

socket.on("user_info", function(user) {
  console.log("👤 معلومات المستخدم:", user);
  currentUser = user;
  
  document.getElementById("user-name").textContent = user.display_name || user.name || user.number;
  
  var userAvatar = document.getElementById("user-avatar");
  updateAvatar(userAvatar, user.pic, user.display_name || user.name || user.number);
  
  if (user.about) {
    document.getElementById("user-name").title = user.about;
  }
});

socket.on("chats", function(chats) {
  console.log("💬 تم تحميل " + chats.length + " محادثة");
  chatsCache = {};
  chats.forEach(chat => {
    chatsCache[chat.id] = chat;
  });
  showChats(chats);
});

socket.on("chat_update", function(chat) {
  console.log("🔄 تم تحديث محادثة");
  chatsCache[chat.id] = chat;
  updateChatInList(chat);
});

socket.on("new_chat_started", function(chat) {
  console.log("➕ محادثة جديدة");
  chatsCache[chat.id] = chat;
  addChatToList(chat);
  openChat(chat);
  showNotification("تم بدء محادثة جديدة", "success");
});

socket.on("message", function(data) {
  console.log("📩 رسالة جديدة");
  
  if (data.session_id !== currentSessionId) return;
  
  if (currentChat && data.chat_id === currentChat) {
    if (!isMessageExists(data.message_id)) {
      showMessage(data, data.is_from_me);
      scrollToBottom();
      playMessageSound();
    }
  }
  
  updateChatPreview(data.chat_id, data.text || "[وسائط]", new Date().toISOString());
});

socket.on("message_status", function(data) {
  updateMessageStatus(data.message_id, data.delivered, data.read);
});

socket.on("load_messages", function(messages) {
  console.log("📨 تم تحميل " + messages.length + " رسالة");
  showMessages(messages);
  scrollToBottom();
});

socket.on("voice_saved", function(data) {
  console.log("🎵 تم حفظ الرسالة الصوتية");
  sendVoiceMessage(data.filePath);
});

socket.on("error", function(msg) {
  console.error("⚠️ خطأ:", msg);
  showNotification(msg, "error");
});

socket.on("disconnect", function() {
  showNotification("انقطع الاتصال بالسيرفر", "error");
});

socket.on("logged_out", function() {
  localStorage.removeItem('whatsapp_session');
  currentSessionId = null;
  showNotification("تم تسجيل الخروج", "info");
  setTimeout(() => {
    location.reload();
  }, 2000);
});

// التحقق من وجود الرسالة
function isMessageExists(messageId) {
  const container = document.getElementById("messages-container");
  return container.querySelector(`[data-message-id="${messageId}"]`) !== null;
}

// تحديث حالة الرسالة
function updateMessageStatus(messageId, delivered, read) {
  const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
  if (messageElement) {
    const statusElement = messageElement.querySelector('.message-status');
    if (statusElement) {
      if (read) {
        statusElement.innerHTML = '✓✓ <span style="color:#34B7F1">✓</span>';
      } else if (delivered) {
        statusElement.innerHTML = '✓✓';
      }
    }
  }
}

// تحديث الصورة
function updateAvatar(element, picUrl, name) {
  if (!element) return;
  
  if (picUrl) {
    // إضافة طابع زمني لمنع التخزين المؤقت
    const timestamp = Date.now();
    const urlWithTimestamp = picUrl.includes('?') ? 
      `${picUrl}&t=${timestamp}` : `${picUrl}?t=${timestamp}`;
    
    element.style.backgroundImage = `url('${urlWithTimestamp}')`;
    element.style.backgroundSize = 'cover';
    element.style.backgroundPosition = 'center';
    element.innerHTML = '';
  } else {
    element.style.backgroundImage = 'none';
    element.innerHTML = getInitials(name);
  }
}

// إظهار شاشة معينة
function showScreen(screenName) {
  var screens = ["login", "chats", "chat"];
  screens.forEach(function(screen) {
    document.getElementById(screen).classList.remove("active");
  });
  document.getElementById(screenName).classList.add("active");
  
  hideEmojiPicker();
  
  // عند العودة للمحادثات، تحديث العرض
  if (screenName === "chats") {
    setTimeout(refreshChats, 100);
  }
}

// تحميل المحادثات
function loadChats() {
  if (!currentSessionId) {
    console.log("❌ لا يوجد جلسة نشطة");
    showNotification("يرجى تسجيل الدخول أولاً", "warning");
    return;
  }
  
  showLoading(true);
  fetch(`/chats/${currentSessionId}?t=${Date.now()}`)
    .then(function(response) { 
      if (!response.ok) throw new Error('فشل تحميل المحادثات');
      return response.json(); 
    })
    .then(function(chats) {
      showChats(chats);
      showLoading(false);
    })
    .catch(function(error) {
      console.error('فشل تحميل المحادثات:', error);
      document.getElementById("chats-list").innerHTML = `
        <div class="error-message">
          <i class="fas fa-exclamation-triangle"></i>
          <p>فشل تحميل المحادثات</p>
          <p>${error.message}</p>
          <button onclick="loadChats()" class="retry-btn">إعادة المحاولة</button>
        </div>
      `;
      showLoading(false);
    });
}

// تحديث المحادثات
function refreshChats() {
  loadChats();
  showNotification("تم تحديث المحادثات", "info");
}

// عرض المحادثات
function showChats(chats) {
  var container = document.getElementById("chats-list");
  
  if (!chats || chats.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-comments"></i>
        <p>لا توجد محادثات</p>
        <p class="small">ابدأ محادثة جديدة بالنقر على الزر +</p>
      </div>
    `;
    return;
  }
  
  // حفظ في الكاش
  chats.forEach(chat => {
    chatsCache[chat.id] = chat;
  });
  
  // ترتيب المحادثات حسب الوقت
  chats.sort(function(a, b) {
    var timeA = a.last_time || a.updated_at || new Date(0);
    var timeB = b.last_time || b.updated_at || new Date(0);
    return new Date(timeB) - new Date(timeA);
  });
  
  // تحديث القائمة
  container.innerHTML = "";
  chats.forEach(function(chat) {
    addChatItem(chat);
  });
}

// إضافة عنصر محادثة
function addChatItem(chat) {
  var container = document.getElementById("chats-list");
  
  var div = document.createElement("div");
  div.className = "chat-item";
  div.setAttribute('data-id', chat.id);
  div.setAttribute('data-session', chat.session_id);
  div.onclick = function() { openChat(chat); };
  
  var lastMsg = chat.last_message || "لا توجد رسائل بعد";
  if (lastMsg.length > 30) {
    lastMsg = lastMsg.substring(0, 30) + "...";
  }
  
  var time = formatTime(chat.last_time || chat.updated_at);
  var unreadCount = chat.unread_count || 0;
  var initials = getInitials(chat.display_name || chat.name || chat.number || "?");
  
  var displayName = chat.display_name || chat.name || chat.number || "مستخدم";
  var displayInfo = displayName;
  
  if (chat.about && chat.about.trim() !== "") {
    displayInfo = `${displayName}<br><small class="chat-about">${chat.about}</small>`;
  } else if (chat.number && displayName !== chat.number && chat.number !== "جهة اتصال" && chat.number !== "مجموعة") {
    displayInfo = `${displayName}<br><small class="chat-number">${chat.number}</small>`;
  }
  
  div.innerHTML = `
    <div class="chat-avatar">
      <div class="avatar-img" id="chat-avatar-${chat.id.replace(/[@\.]/g, '-')}">
        ${initials}
      </div>
    </div>
    <div class="chat-info">
      <div class="chat-header">
        <div class="chat-name">${displayInfo}</div>
        <div class="chat-time">${time}</div>
      </div>
      <div class="chat-preview">
        <div class="chat-last">${lastMsg}</div>
        ${unreadCount > 0 ? `<div class="unread-count">${unreadCount > 99 ? '99+' : unreadCount}</div>` : ''}
      </div>
    </div>
  `;
  
  container.appendChild(div);
  
  // تحديث الصورة إذا كانت موجودة
  if (chat.pic) {
    setTimeout(() => {
      var avatar = document.getElementById(`chat-avatar-${chat.id.replace(/[@\.]/g, '-')}`);
      if (avatar) {
        updateAvatar(avatar, chat.pic, chat.display_name || chat.name || chat.number);
      }
    }, 100);
  }
}

// تحديث المحادثة في القائمة
function updateChatInList(chat) {
  var container = document.getElementById("chats-list");
  var existing = container.querySelector(`.chat-item[data-id="${chat.id}"][data-session="${chat.session_id}"]`);
  
  if (existing) {
    container.removeChild(existing);
  }
  
  addChatItem(chat);
}

// تحديث معاينة المحادثة
function updateChatPreview(chatId, lastMessage, timestamp) {
  var chatItem = document.querySelector(`.chat-item[data-id="${chatId}"][data-session="${currentSessionId}"]`);
  if (chatItem) {
    var lastMsgEl = chatItem.querySelector('.chat-last');
    var timeEl = chatItem.querySelector('.chat-time');
    
    if (lastMsgEl) {
      var displayMsg = lastMessage || "لا توجد رسائل";
      if (displayMsg.length > 30) {
        displayMsg = displayMsg.substring(0, 30) + "...";
      }
      lastMsgEl.textContent = displayMsg;
    }
    
    if (timeEl) {
      timeEl.textContent = formatTime(timestamp);
    }
    
    // نقل المحادثة إلى الأعلى
    var container = chatItem.parentNode;
    if (container.firstChild !== chatItem) {
      container.insertBefore(chatItem, container.firstChild);
    }
  }
}

// الحصول على الأحرف الأولى
function getInitials(name) {
  if (!name || name.trim() === "") return "?";
  
  var cleanName = name.replace(/[0-9@\.\+]/g, '').trim();
  if (cleanName === "") return name.substring(0, 2);
  
  var parts = cleanName.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
  }
  return cleanName.charAt(0).toUpperCase();
}

// تنسيق الوقت
function formatTime(dateString) {
  try {
    if (!dateString) return "";
    
    var date = new Date(dateString);
    var now = new Date();
    var diff = now - date;
    var diffDays = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (isNaN(date.getTime())) {
      return "الآن";
    }
    
    if (diffDays === 0) {
      var hours = date.getHours();
      var minutes = date.getMinutes();
      var ampm = hours >= 12 ? "م" : "ص";
      hours = hours % 12;
      hours = hours ? hours : 12;
      return hours + ":" + (minutes < 10 ? '0' : '') + minutes + " " + ampm;
    } else if (diffDays === 1) {
      return "أمس";
    } else if (diffDays < 7) {
      var days = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
      return days[date.getDay()];
    } else {
      return date.getDate() + "/" + (date.getMonth() + 1) + "/" + date.getFullYear().toString().substr(-2);
    }
  } catch (e) {
    console.error("خطأ في تنسيق الوقت:", e);
    return "الآن";
  }
}

// فتح محادثة
function openChat(chat) {
  currentChat = chat.id;
  currentChatData = chat;
  
  showScreen("chat");
  
  var contactName = chat.display_name || chat.name || chat.number || "مستخدم";
  document.getElementById("chat-contact-name").textContent = contactName;
  
  var statusText = "";
  if (chat.about && chat.about.trim() !== "") {
    statusText = chat.about;
  } else if (chat.is_group) {
    statusText = "مجموعة";
  } else if (chat.number && chat.number !== "جهة اتصال") {
    statusText = chat.number;
  } else {
    statusText = "مستقبل الرسائل";
  }
  document.getElementById("chat-contact-status").textContent = statusText;
  
  var contactAvatar = document.getElementById("chat-contact-avatar");
  updateAvatar(contactAvatar, chat.pic, contactName);
  
  document.getElementById("messages-container").innerHTML = `
    <div class="loading-messages">
      <div class="spinner small"></div>
      <div>جارٍ تحميل الرسائل...</div>
    </div>
  `;
  
  document.getElementById("message-input").disabled = false;
  document.getElementById("send-btn").disabled = false;
  
  socket.emit("get_messages", { 
    chatId: chat.id, 
    sessionId: currentSessionId 
  });
  
  setTimeout(() => {
    var input = document.getElementById("message-input");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }, 500);
}

// العودة لقائمة المحادثات
function goBack() {
  currentChat = null;
  currentChatData = null;
  
  showScreen("chats");
  
  if (isRecording) {
    stopRecording();
  }
  
  hideEmojiPicker();
  loadChats();
}

// عرض الرسائل
function showMessages(messages) {
  var container = document.getElementById("messages-container");
  container.innerHTML = "";
  
  if (!messages || messages.length === 0) {
    container.innerHTML = `
      <div class="empty-messages">
        <i class="fas fa-comment-slash"></i>
        <p>لا توجد رسائل بعد</p>
        <p class="small">ابدأ المحادثة بإرسال رسالة</p>
      </div>
    `;
    return;
  }
  
  var lastDate = null;
  
  messages.forEach(function(msg) {
    var messageDate = new Date(msg.timestamp).toDateString();
    
    if (messageDate !== lastDate) {
      var dateDiv = document.createElement("div");
      dateDiv.className = "date-divider";
      dateDiv.innerHTML = `<span>${formatDateHeader(msg.timestamp)}</span>`;
      container.appendChild(dateDiv);
      lastDate = messageDate;
    }
    
    showMessage({
      message_id: msg.message_id,
      text: msg.content,
      media: msg.media_url,
      media_type: msg.media_type,
      media_name: msg.media_name,
      timestamp: msg.timestamp,
      is_from_me: msg.is_from_me,
      sender_name: msg.sender_name,
      sender_number: msg.sender_number,
      delivered: msg.delivered,
      read_receipt: msg.read_receipt
    }, msg.is_from_me);
  });
}

// تنسيق عنوان التاريخ
function formatDateHeader(dateString) {
  var date = new Date(dateString);
  var today = new Date();
  var yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  
  if (date.toDateString() === today.toDateString()) {
    return "اليوم";
  } else if (date.toDateString() === yesterday.toDateString()) {
    return "أمس";
  } else {
    var options = { day: 'numeric', month: 'long', year: 'numeric' };
    return date.toLocaleDateString('ar-SA', options);
  }
}

// عرض رسالة
function showMessage(data, isSelf) {
  var container = document.getElementById("messages-container");
  var div = document.createElement("div");
  div.className = "message" + (isSelf ? " outgoing" : " incoming");
  div.setAttribute('data-message-id', data.message_id || 'temp_' + Date.now());
  
  var time = formatTime(data.timestamp);
  var content = "";
  
  if (data.sender_name && !isSelf && data.sender_name !== "أنا") {
    var displayName = data.sender_name;
    if (data.sender_number && data.sender_name !== data.sender_number && 
        data.sender_number !== "جهة اتصال" && data.sender_number !== "مجموعة") {
      displayName = `${data.sender_name}<br><small>${data.sender_number}</small>`;
    }
    
    content += '<div class="sender-name">' + displayName + '</div>';
  }
  
  if (data.media) {
    if (data.media_type === 'image') {
      content += '<div class="message-media"><img src="' + data.media + '" onclick="viewImage(\'' + data.media + '\')" loading="lazy" alt="صورة" class="media-preview"></div>';
    } else if (data.media_type === 'audio') {
      content += '<div class="message-audio"><audio controls preload="none"><source src="' + data.media + '" type="audio/ogg"></audio></div>';
    } else if (data.media_type === 'video') {
      content += '<div class="message-video"><video controls preload="metadata"><source src="' + data.media + '"></video></div>';
    } else if (data.media_type === 'document') {
      var fileName = data.media_name || 'ملف مرفق';
      content += '<div class="message-document"><a href="' + data.media + '" download="' + fileName + '"><i class="fas fa-file-download"></i> ' + fileName + '</a></div>';
    } else {
      content += '<div class="message-document"><a href="' + data.media + '" download><i class="fas fa-file"></i> ملف مرفق</a></div>';
    }
  }
  
  if (data.text && data.text !== '[وسائط]') {
    var textWithLinks = data.text.replace(
      /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig,
      '<a href="$1" target="_blank" rel="noopener">$1</a>'
    );
    content += '<div class="message-text">' + textWithLinks + '</div>';
  }
  
  content += '<div class="message-meta">';
  content += '<div class="message-time">' + time + '</div>';
  if (isSelf) {
    var statusIcon = '✓';
    if (data.read_receipt) {
      statusIcon = '✓✓ <span style="color:#34B7F1">✓</span>';
    } else if (data.delivered) {
      statusIcon = '✓✓';
    }
    content += '<div class="message-status">' + statusIcon + '</div>';
  }
  content += '</div>';
  
  div.innerHTML = content;
  container.appendChild(div);
  
  // إضافة تأثير ظهور
  div.style.opacity = '0';
  div.style.transform = 'translateY(10px)';
  setTimeout(() => {
    div.style.transition = 'opacity 0.3s, transform 0.3s';
    div.style.opacity = '1';
    div.style.transform = 'translateY(0)';
  }, 10);
}

// إرسال رسالة
function sendMessage() {
  var input = document.getElementById("message-input");
  var text = input.value.trim();
  
  if (!text || !currentChat || !currentSessionId) {
    showNotification("اكتب رسالة أولاً", "warning");
    return;
  }
  
  socket.emit("send_message", {
    to: currentChat,
    text: text
  });
  
  input.value = "";
  input.focus();
  playSendSound();
  hideEmojiPicker();
}

// إرسال رسالة صوتية
function sendVoiceMessage(filePath) {
  if (!currentChat || !currentSessionId) {
    showNotification("اختر محادثة أولاً", "warning");
    return;
  }
  
  console.log("🎤 إرسال رسالة صوتية:", filePath);
  
  socket.emit("send_media", {
    to: currentChat,
    filePath: filePath,
    mediaType: 'audio',
    isVoiceMessage: true,
    caption: 'رسالة صوتية'
  });
  
  showNotification("تم إرسال الرسالة الصوتية", "success");
}

// بدء تسجيل صوتي
function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showNotification("المتصفح لا يدعم التسجيل الصوتي", "error");
    return;
  }
  
  if (!currentChat || !currentSessionId) {
    showNotification("اختر محادثة أولاً", "warning");
    return;
  }
  
  navigator.mediaDevices.getUserMedia({ 
    audio: {
      channelCount: 1,
      sampleRate: 44100,
      echoCancellation: true,
      noiseSuppression: true
    }
  })
    .then(function(stream) {
      isRecording = true;
      audioChunks = [];
      
      const options = { 
        mimeType: 'audio/webm;codecs=opus',
        audioBitsPerSecond: 128000
      };
      
      try {
        mediaRecorder = new MediaRecorder(stream, options);
      } catch (e) {
        mediaRecorder = new MediaRecorder(stream);
      }
      
      mediaRecorder.ondataavailable = function(event) {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };
      
      mediaRecorder.onstop = function() {
        var audioBlob = new Blob(audioChunks, { 
          type: mediaRecorder.mimeType || 'audio/webm' 
        });
        
        var reader = new FileReader();
        reader.onloadend = function() {
          var base64data = reader.result;
          var fileName = 'voice_' + Date.now() + '.ogg';
          
          fetch('/save_voice', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              audioData: base64data,
              fileName: fileName
            })
          })
          .then(response => response.json())
          .then(result => {
            if (result.success) {
              sendVoiceMessage(result.filePath);
            } else {
              showNotification("فشل حفظ الرسالة الصوتية", "error");
            }
          })
          .catch(error => {
            console.error('❌ خطأ في حفظ الرسالة الصوتية:', error);
            showNotification("فشل حفظ الرسالة الصوتية", "error");
          });
        };
        
        reader.readAsDataURL(audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };
      
      mediaRecorder.start(100);
      recordingStartTime = Date.now();
      
      document.getElementById("recording-area").style.display = "block";
      document.getElementById("message-input-area").style.display = "none";
      
      document.getElementById("record-btn").innerHTML = '<i class="fas fa-stop"></i>';
      document.getElementById("record-btn").onclick = stopRecording;
      
      updateRecordingTimer();
      recordingTimer = setInterval(updateRecordingTimer, 1000);
      
      startVisualizer();
      
    })
    .catch(function(error) {
      console.error("❌ خطأ في التسجيل:", error);
      showNotification("فشل الوصول للميكروفون: " + error.message, "error");
    });
}

// إيقاف التسجيل
function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  
  isRecording = false;
  
  if (mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  
  clearInterval(recordingTimer);
  stopVisualizer();
  
  document.getElementById("recording-area").style.display = "none";
  document.getElementById("message-input-area").style.display = "flex";
  
  document.getElementById("record-btn").innerHTML = '<i class="fas fa-microphone"></i>';
  document.getElementById("record-btn").onclick = startRecording;
  
  showNotification("جارٍ إرسال الرسالة الصوتية...", "info");
}

// إلغاء التسجيل
function cancelRecording() {
  if (!isRecording || !mediaRecorder) return;
  
  isRecording = false;
  
  if (mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  
  clearInterval(recordingTimer);
  stopVisualizer();
  
  document.getElementById("recording-area").style.display = "none";
  document.getElementById("message-input-area").style.display = "flex";
  
  document.getElementById("record-btn").innerHTML = '<i class="fas fa-microphone"></i>';
  document.getElementById("record-btn").onclick = startRecording;
  
  showNotification("تم إلغاء التسجيل", "info");
}

// التبديل بين التسجيل والإدخال
function toggleRecord() {
  if (!currentChat || !currentSessionId) {
    showNotification("اختر محادثة أولاً", "warning");
    return;
  }
  
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

// تحديث مؤقت التسجيل
function updateRecordingTimer() {
  if (!recordingStartTime) return;
  
  var elapsed = Date.now() - recordingStartTime;
  var seconds = Math.floor(elapsed / 1000);
  var minutes = Math.floor(seconds / 60);
  seconds = seconds % 60;
  
  var timerText = (minutes < 10 ? '0' : '') + minutes + ":" + (seconds < 10 ? '0' : '') + seconds;
  document.getElementById("recording-timer").textContent = timerText;
  
  if (minutes >= 5) {
    stopRecording();
  }
}

// تشغيل المؤثرات البصرية للتسجيل
function startVisualizer() {
  var bars = document.querySelectorAll('#recording-visualizer .bar');
  bars.forEach(function(bar, index) {
    bar.style.animation = 'visualizer 0.8s infinite alternate';
    bar.style.animationDelay = (index * 0.1) + 's';
  });
}

// إيقاف المؤثرات البصرية
function stopVisualizer() {
  var bars = document.querySelectorAll('#recording-visualizer .bar');
  bars.forEach(function(bar) {
    bar.style.animation = 'none';
    bar.style.height = '10px';
  });
}

// إظهار منتقي الإيموجي
function showEmojiPicker() {
  var pickerContainer = document.getElementById("emoji-picker-container");
  if (pickerContainer.style.display === "block") {
    hideEmojiPicker();
    return;
  }
  
  pickerContainer.style.display = "block";
  loadEmojis();
}

// إخفاء منتقي الإيموجي
function hideEmojiPicker() {
  var pickerContainer = document.getElementById("emoji-picker-container");
  pickerContainer.style.display = "none";
}

// تحميل الإيموجيات
function loadEmojis() {
  var emojiPicker = document.getElementById("emoji-picker");
  emojiPicker.innerHTML = "";
  
  var commonEmojis = [
    "😀", "😂", "🥰", "😎", "😜", "😢", "😠", "😍", "🤔", "👍",
    "👎", "👋", "🎉", "❤️", "🔥", "⭐", "🙏", "💯", "👏", "🤝",
    "😊", "🤗", "😇", "😘", "😋", "🤪", "😎", "🤓", "🥳", "😴",
    "😭", "😤", "🤯", "😱", "🥺", "😈", "🤡", "💩", "👻", "🙈",
    "💪", "🧠", "👀", "👅", "👂", "👃", "💋", "🦶", "👄", "🦷"
  ];
  
  if (emojiHistory.length > 0) {
    var recentSection = document.createElement("div");
    recentSection.className = "emoji-section";
    recentSection.innerHTML = "<h4>مستخدمة مؤخراً</h4>";
    
    var recentContainer = document.createElement("div");
    recentContainer.className = "emoji-grid";
    
    emojiHistory.slice(0, 12).forEach(function(emoji) {
      var span = createEmojiElement(emoji);
      recentContainer.appendChild(span);
    });
    
    recentSection.appendChild(recentContainer);
    emojiPicker.appendChild(recentSection);
  }
  
  var commonSection = document.createElement("div");
  commonSection.className = "emoji-section";
  commonSection.innerHTML = "<h4>إيموجيات شائعة</h4>";
  
  var commonContainer = document.createElement("div");
  commonContainer.className = "emoji-grid";
  
  commonEmojis.forEach(function(emoji) {
    var span = createEmojiElement(emoji);
    commonContainer.appendChild(span);
  });
  
  commonSection.appendChild(commonContainer);
  emojiPicker.appendChild(commonSection);
  
  var emojiCategories = {
    "وجوه": ["😀", "😂", "🥰", "😎", "😜", "😢", "😠", "😍", "🤔", "😊", "🤗", "😇", "😘", "😋"],
    "إيماءات": ["👍", "👎", "👋", "🙏", "👏", "🤝", "💪", "👀", "🤞", "✌️"],
    "قلوب": ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔"],
    "أشياء": ["🔥", "⭐", "🎉", "💯", "🎁", "🎈", "🎊", "🏆", "⚽", "🎮"],
    "حيوانات": ["🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯"],
    "طعام": ["🍎", "🍕", "🍔", "🍟", "🍦", "🍫", "🍩", "🍵", "☕", "🍺"]
  };
  
  for (var category in emojiCategories) {
    var section = document.createElement("div");
    section.className = "emoji-section";
    section.innerHTML = "<h4>" + category + "</h4>";
    
    var container = document.createElement("div");
    container.className = "emoji-grid";
    
    emojiCategories[category].forEach(function(emoji) {
      var span = createEmojiElement(emoji);
      container.appendChild(span);
    });
    
    section.appendChild(container);
    emojiPicker.appendChild(section);
  }
}

// إنشاء عنصر إيموجي
function createEmojiElement(emoji) {
  var span = document.createElement("span");
  span.className = "emoji-item";
  span.textContent = emoji;
  span.onclick = function() {
    insertEmoji(emoji);
  };
  return span;
}

// إدخال إيموجي في حقل النص
function insertEmoji(emoji) {
  var input = document.getElementById("message-input");
  var start = input.selectionStart;
  var end = input.selectionEnd;
  
  input.value = input.value.substring(0, start) + emoji + input.value.substring(end);
  input.focus();
  input.setSelectionRange(start + emoji.length, start + emoji.length);
  
  addToEmojiHistory(emoji);
}

// إضافة إيموجي للسجل
function addToEmojiHistory(emoji) {
  emojiHistory = emojiHistory.filter(e => e !== emoji);
  emojiHistory.unshift(emoji);
  
  if (emojiHistory.length > 20) {
    emojiHistory = emojiHistory.slice(0, 20);
  }
  
  localStorage.setItem('emojiHistory', JSON.stringify(emojiHistory));
}

// محادثة جديدة
function showNewChat() {
  document.getElementById("new-chat-modal").style.display = "flex";
  document.getElementById("new-chat-number").focus();
}

function closeNewChat() {
  document.getElementById("new-chat-modal").style.display = "none";
  document.getElementById("new-chat-number").value = "";
}

function createNewChat() {
  var phoneInput = document.getElementById("new-chat-number");
  var phoneNumber = phoneInput.value.trim();
  
  if (!phoneNumber) {
    showNotification("أدخل رقم الهاتف أولاً", "warning");
    phoneInput.focus();
    return;
  }
  
  phoneNumber = phoneNumber.replace(/\D/g, '');
  
  if (phoneNumber.length < 10) {
    showNotification("رقم الهاتف غير صالح", "error");
    phoneInput.focus();
    return;
  }
  
  if (phoneNumber.length === 10 && !phoneNumber.startsWith('2')) {
    phoneNumber = '2' + phoneNumber;
  }
  
  socket.emit("start_new_chat", phoneNumber);
  
  closeNewChat();
  showNotification("جارٍ بدء المحادثة...", "info");
}

// التحقق من إدخال الأرقام فقط
function isNumberKey(evt) {
  var charCode = (evt.which) ? evt.which : evt.keyCode;
  if (charCode > 31 && (charCode < 48 || charCode > 57)) {
    return false;
  }
  return true;
}

// البحث في المحادثات
function searchChats(query) {
  var chatItems = document.querySelectorAll('.chat-item');
  var searchTerm = query.toLowerCase().trim();
  
  if (!searchTerm) {
    chatItems.forEach(item => item.style.display = 'flex');
    return;
  }
  
  chatItems.forEach(function(item) {
    var chatName = item.querySelector('.chat-name').textContent.toLowerCase();
    var chatLastMsg = item.querySelector('.chat-last').textContent.toLowerCase();
    
    if (chatName.includes(searchTerm) || chatLastMsg.includes(searchTerm)) {
      item.style.display = 'flex';
    } else {
      item.style.display = 'none';
    }
  });
}

// إرسال صورة أو ملف
function attachImage() {
  if (!currentChat || !currentSessionId) {
    showNotification("اختر محادثة أولاً", "warning");
    return;
  }
  
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '*/*';
  input.multiple = false;
  
  input.onchange = function(e) {
    var file = e.target.files[0];
    if (!file) return;
    
    // التحقق من حجم الملف (100MB كحد أقصى)
    if (file.size > 100 * 1024 * 1024) {
      showNotification("حجم الملف كبير جداً (100MB كحد أقصى)", "error");
      return;
    }
    
    var mediaType = 'document';
    var isVoiceMessage = false;
    
    if (file.type.startsWith('image/')) {
      mediaType = 'image';
    } else if (file.type.startsWith('video/')) {
      mediaType = 'video';
    } else if (file.type.startsWith('audio/')) {
      mediaType = 'audio';
      // إذا كان اسم الملف يحتوي على "voice" فهو رسالة صوتية
      isVoiceMessage = file.name.toLowerCase().includes('voice');
    }
    
    // إذا كان امتداد الملف .3gp وكان صورة، سيتم تحويله تلقائياً في السيرفر
    var fileExt = file.name.toLowerCase().split('.').pop();
    if (fileExt === '3gp' && mediaType === 'image') {
      showNotification("جارٍ تحويل صورة 3gp إلى JPG...", "info");
    }
    
    var formData = new FormData();
    formData.append('file', file);
    
    showLoading(true);
    showNotification("جارٍ رفع الملف...", "info");
    
    fetch('/upload', {
      method: 'POST',
      body: formData
    })
    .then(function(response) { 
      showLoading(false);
      return response.json(); 
    })
    .then(function(result) {
      if (result.success) {
        socket.emit("send_media", {
          to: currentChat,
          filePath: result.filePath,
          mediaType: mediaType,
          isVoiceMessage: isVoiceMessage,
          caption: file.name
        });
        showNotification("تم إرسال الملف", "success");
      } else {
        showNotification("فشل رفع الملف: " + (result.error || ""), "error");
      }
    })
    .catch(function(error) {
      showLoading(false);
      console.error('فشل رفع الملف:', error);
      showNotification("فشل إرسال الملف", "error");
    });
  };
  
  input.click();
}

// عرض صورة
function viewImage(src) {
  var modal = document.createElement('div');
  modal.className = 'image-viewer-modal';
  modal.innerHTML = `
    <div class="image-viewer-content">
      <button class="close-image-btn" onclick="this.parentElement.parentElement.remove()">&times;</button>
      <img src="${src}" alt="صورة" style="max-width: 90vw; max-height: 90vh;">
      <div class="image-actions">
        <a href="${src}" download class="download-image-btn">
          <i class="fas fa-download"></i> تحميل
        </a>
      </div>
    </div>
  `;
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.9);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `;
  document.body.appendChild(modal);
  
  // إغلاق بالنقر خارج الصورة
  modal.onclick = function(e) {
    if (e.target === modal) {
      modal.remove();
    }
  };
}

// التمرير لآخر رسالة
function scrollToBottom() {
  setTimeout(function() {
    var container = document.getElementById("messages-container");
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, 100);
}

// التعامل مع ضغط المفاتيح
function handleInputKeyPress(e) {
  if (e.key === 'Enter') {
    sendMessage();
    e.preventDefault();
  }
}

// إظهار إشعار
function showNotification(message, type) {
  var notification = document.getElementById("notification");
  notification.textContent = message;
  notification.className = "notification " + (type || "info");
  notification.style.display = "block";
  
  setTimeout(function() {
    notification.style.display = "none";
  }, 3000);
}

// إظهار/إخفاء التحميل
function showLoading(show) {
  var loading = document.getElementById("loading");
  loading.style.display = show ? "flex" : "none";
}

// تشغيل صوت الرسالة
function playMessageSound() {
  try {
    var audio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAZGF0YQ');
    audio.volume = 0.3;
    audio.play();
  } catch (e) {}
}

// تشغيل صوت الإرسال
function playSendSound() {
  try {
    var audio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAZGF0YQ');
    audio.volume = 0.1;
    audio.play();
  } catch (e) {}
}

// تسجيل الخروج
function logout() {
  if (confirm("هل تريد تسجيل الخروج من واتساب؟ سيتم حذف جميع المحادثات المحفوظة.")) {
    socket.emit("logout");
    showNotification("جارٍ تسجيل الخروج...", "info");
  }
}

// التحقق من حالة التطبيق
function checkAppStatus() {
  fetch('/status')
    .then(response => response.json())
    .then(status => {
      console.log("📊 حالة التطبيق:", status);
      if (!status.isReady && !status.hasQr) {
        showNotification("واتساب غير متصل، جاري إعادة الاتصال...", "warning");
      }
    })
    .catch(error => {
      console.error('❌ خطأ في التحقق من الحالة:', error);
    });
}

// عند تحميل الصفحة
window.onload = function() {
  console.log("📱 التطبيق جاهز للهواتف القديمة والزرارية");
  
  var input = document.getElementById("message-input");
  if (input) {
    input.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        sendMessage();
        e.preventDefault();
      }
    });
  }
  
  // تسجيل Service Worker للتطبيق
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js')
      .then(function(registration) {
        console.log('✅ Service Worker مسجل:', registration.scope);
        
        // التحقق من التحديثات
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showNotification("توجد نسخة جديدة من التطبيق، يرجى تحديث الصفحة", "info");
            }
          });
        });
      })
      .catch(function(error) {
        console.log('❌ فشل تسجيل Service Worker:', error);
      });
    
    // التحقق من التثبيت
    if (navigator.serviceWorker.controller) {
      console.log('✅ التطبيق يعمل في وضع عدم الاتصال');
    }
  }
  
  // إظهار زر التثبيت
  let deferredPrompt;
  
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    
    // إظهار زر التثبيت
    var installBtn = document.createElement('button');
    installBtn.className = 'chats-icon-btn install-app-btn';
    installBtn.title = 'تثبيت التطبيق';
    installBtn.innerHTML = '<i class="fas fa-download"></i>';
    installBtn.onclick = async function() {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          console.log('✅ تم تثبيت التطبيق');
          showNotification("تم تثبيت التطبيق بنجاح", "success");
          installBtn.style.display = 'none';
        }
        deferredPrompt = null;
      }
    };
    
    var chatsActions = document.querySelector('.chats-actions');
    if (chatsActions) {
      // التحقق من عدم وجود الزر مسبقاً
      if (!chatsActions.querySelector('.install-app-btn')) {
        chatsActions.insertBefore(installBtn, chatsActions.firstChild);
      }
    }
  });
  
  // إضافة أزرار الإجراءات (فقط تسجيل الخروج)
  var chatsActions = document.querySelector('.chats-actions');
  if (chatsActions) {
    // زر تسجيل الخروج
    var logoutBtn = document.createElement('button');
    logoutBtn.className = 'chats-icon-btn logout-btn';
    logoutBtn.title = 'تسجيل الخروج';
    logoutBtn.innerHTML = '<i class="fas fa-sign-out-alt"></i>';
    logoutBtn.onclick = logout;
    chatsActions.appendChild(logoutBtn);
  }
  
  // إضافة زر الإيموجي
  var inputButtons = document.querySelector('.input-buttons');
  if (inputButtons) {
    var emojiBtn = document.createElement('button');
    emojiBtn.className = 'input-btn emoji-btn';
    emojiBtn.title = 'ايموجي';
    emojiBtn.innerHTML = '<i class="fas fa-smile"></i>';
    emojiBtn.onclick = showEmojiPicker;
    inputButtons.insertBefore(emojiBtn, inputButtons.firstChild);
  }
  
  // إضافة زر المرفقات
  if (inputButtons) {
    var attachBtn = document.createElement('button');
    attachBtn.className = 'input-btn attach-btn';
    attachBtn.title = 'ملفات';
    attachBtn.innerHTML = '<i class="fas fa-paperclip"></i>';
    attachBtn.onclick = function() {
      if (!currentChat || !currentSessionId) {
        showNotification("اختر محادثة أولاً", "warning");
        return;
      }
      
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '*/*';
      input.multiple = true;
      
      input.onchange = function(e) {
        var files = Array.from(e.target.files);
        files.forEach(file => {
          var reader = new FileReader();
          reader.onload = function(event) {
            var formData = new FormData();
            formData.append('file', file);
            
            showNotification("جارٍ رفع الملف: " + file.name, "info");
            
            fetch('/upload', {
              method: 'POST',
              body: formData
            })
            .then(response => response.json())
            .then(result => {
              if (result.success) {
                var mediaType = 'document';
                var isVoiceMessage = false;
                
                if (file.type.startsWith('image/')) mediaType = 'image';
                else if (file.type.startsWith('video/')) mediaType = 'video';
                else if (file.type.startsWith('audio/')) {
                  mediaType = 'audio';
                  isVoiceMessage = file.name.toLowerCase().includes('voice');
                }
                
                socket.emit("send_media", {
                  to: currentChat,
                  filePath: result.filePath,
                  mediaType: mediaType,
                  isVoiceMessage: isVoiceMessage,
                  caption: file.name
                });
                
                showNotification("تم إرسال الملف: " + file.name, "success");
              }
            });
          };
          reader.readAsArrayBuffer(file);
        });
      };
      
      input.click();
    };
    inputButtons.appendChild(attachBtn);
  }
  
  // إغلاق منتقي الإيموجي عند النقر خارجها
  document.addEventListener('click', function(event) {
    var pickerContainer = document.getElementById("emoji-picker-container");
    var emojiBtn = document.querySelector('.input-btn.emoji-btn');
    
    if (pickerContainer && pickerContainer.style.display === "block" &&
        !pickerContainer.contains(event.target) && 
        event.target !== emojiBtn && 
        !emojiBtn.contains(event.target)) {
      hideEmojiPicker();
    }
  });
  
  // التحقق من حالة التطبيق كل 30 ثانية
  setInterval(checkAppStatus, 30000);
  
  // التحقق مما إذا كان المتصفح يدعم PWA
  if (window.matchMedia('(display-mode: standalone)').matches) {
    console.log('✅ التطبيق يعمل في وضع standalone');
    document.body.classList.add('standalone');
  }
  
  // التحقق من وضع عدم الاتصال
  window.addEventListener('online', () => {
    showNotification("تم استعادة الاتصال بالإنترنت", "success");
    // محاولة إعادة الاتصال بالسيرفر
    setTimeout(() => {
      if (!socket.connected) {
        socket.connect();
      }
    }, 1000);
  });
  
  window.addEventListener('offline', () => {
    showNotification("تم فقدان الاتصال بالإنترنت", "error");
  });
  
  // إضافة معالج للأخطاء غير المتوقعة
  window.addEventListener('error', function(e) {
    console.error('⚠️ خطأ غير متوقع:', e.message, e.filename, e.lineno);
  });
};
