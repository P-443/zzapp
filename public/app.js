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

// أحداث السوكيت
socket.on("connect", function() {
  console.log("✅ متصل بالسيرفر");
  showNotification("متصل بالسيرفر", "success");
});

socket.on("waiting", function() {
  console.log("⏳ في انتظار الاتصال");
  showScreen("login");
  document.getElementById("status").innerHTML = "جارٍ الاتصال...";
});

socket.on("qr", function(qr) {
  console.log("📱 كود QR متاح");
  showScreen("login");
  document.getElementById("qr").src = qr;
  document.getElementById("status").innerHTML = "مسح الكود للدخول";
});

socket.on("ready", function() {
  console.log("🚀 جاهز للاستخدام");
  showScreen("chats");
  loadChats();
  showNotification("تم الاتصال بواتساب", "success");
});

socket.on("user_info", function(user) {
  console.log("👤 معلومات المستخدم:", user);
  currentUser = user;
  
  // تحديث واجهة المستخدم
  document.getElementById("user-name").textContent = user.name || user.number;
  
  // عرض صورة المستخدم إذا كانت متوفرة
  var userAvatar = document.getElementById("user-avatar");
  updateAvatar(userAvatar, user.pic, user.name || user.number);
});

socket.on("chats", function(chats) {
  console.log("💬 تم تحميل " + chats.length + " محادثة");
  showChats(chats);
});

socket.on("chat_update", function(chat) {
  console.log("🔄 تم تحديث محادثة");
  updateChatInList(chat);
});

socket.on("new_chat_started", function(chat) {
  console.log("➕ محادثة جديدة");
  addChatToList(chat);
  openChat(chat);
  showNotification("تم بدء محادثة جديدة", "success");
});

socket.on("message", function(data) {
  console.log("📩 رسالة جديدة");
  if (currentChat && data.from === currentChat) {
    showMessage(data, data.self);
    scrollToBottom();
    playMessageSound();
  }
  
  // تحديث معاينة المحادثة
  updateChatPreview(data.from, data.text || "[وسائط]", new Date().toISOString());
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
  showNotification("تم تسجيل الخروج", "info");
  setTimeout(() => {
    location.reload();
  }, 2000);
});

// تحديث الصورة
function updateAvatar(element, picUrl, name) {
  if (!element) return;
  
  if (picUrl) {
    element.style.backgroundImage = `url('${picUrl}')`;
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
}

// تحميل المحادثات
function loadChats() {
  showLoading(true);
  fetch('/chats')
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
  container.innerHTML = "";
  
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
  
  // ترتيب المحادثات حسب الوقت
  chats.sort(function(a, b) {
    var timeA = a.last_time || a.updated_at || new Date(0);
    var timeB = b.last_time || b.updated_at || new Date(0);
    return new Date(timeB) - new Date(timeA);
  });
  
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
  div.onclick = function() { openChat(chat); };
  
  var lastMsg = chat.last_message || "لا توجد رسائل بعد";
  if (lastMsg.length > 30) {
    lastMsg = lastMsg.substring(0, 30) + "...";
  }
  
  var time = formatTime(chat.last_time || chat.updated_at);
  var unreadCount = chat.unread_count || 0;
  var initials = getInitials(chat.name || chat.number || "?");
  
  // عرض الاسم والرقم معاً
  var displayName = chat.name || chat.number || "مستخدم";
  if (chat.name && chat.number && chat.name !== chat.number) {
    displayName = `${chat.name}<br><small>${chat.number}</small>`;
  }
  
  div.innerHTML = `
    <div class="chat-avatar">
      <div class="avatar-img" id="chat-avatar-${chat.id.replace(/[@\.]/g, '-')}">
        ${initials}
      </div>
    </div>
    <div class="chat-info">
      <div class="chat-header">
        <div class="chat-name">${displayName}</div>
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
        updateAvatar(avatar, chat.pic, chat.name || chat.number);
      }
    }, 100);
  }
}

// تحديث المحادثة في القائمة
function updateChatInList(chat) {
  var container = document.getElementById("chats-list");
  var existing = container.querySelector(`.chat-item[data-id="${chat.id}"]`);
  
  if (existing) {
    container.removeChild(existing);
  }
  
  // أضف المحادثة في البداية
  addChatItem(chat);
}

// تحديث معاينة المحادثة
function updateChatPreview(chatId, lastMessage, timestamp) {
  var chatItem = document.querySelector(`.chat-item[data-id="${chatId}"]`);
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
    chatItem.parentNode.insertBefore(chatItem, chatItem.parentNode.firstChild);
  }
}

// الحصول على الأحرف الأولى
function getInitials(name) {
  if (!name || name.trim() === "") return "?";
  
  // إزالة الأرقام من الاسم
  var cleanName = name.replace(/[0-9]/g, '').trim();
  if (cleanName === "") return name.substring(0, 2);
  
  var parts = cleanName.split(' ');
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
      return date.getDate() + "/" + (date.getMonth() + 1);
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
  
  // إظهار شاشة المحادثة
  showScreen("chat");
  
  // تحديث معلومات المحادثة
  var contactName = chat.name || chat.number || "مستخدم";
  document.getElementById("chat-contact-name").textContent = contactName;
  
  // عرض الاسم والرقم في الحالة
  var statusText = chat.is_group ? "مجموعة" : chat.number || "مستقبل الرسائل";
  document.getElementById("chat-contact-status").textContent = statusText;
  
  // عرض صورة جهة الاتصال
  var contactAvatar = document.getElementById("chat-contact-avatar");
  updateAvatar(contactAvatar, chat.pic, contactName);
  
  // مسح الرسائل السابقة
  document.getElementById("messages-container").innerHTML = `
    <div class="loading-messages">
      <div class="spinner small"></div>
      <div>جارٍ تحميل الرسائل...</div>
    </div>
  `;
  
  // تفعيل حقل الإدخال
  document.getElementById("message-input").disabled = false;
  document.getElementById("send-btn").disabled = false;
  
  // طلب الرسائل
  socket.emit("get_messages", chat.id);
  
  // التركيز على حقل الإدخال
  setTimeout(() => {
    var input = document.getElementById("message-input");
    if (input) {
      input.focus();
      // وضع المؤشر في نهاية النص
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }, 500);
}

// العودة لقائمة المحادثات
function goBack() {
  currentChat = null;
  currentChatData = null;
  
  showScreen("chats");
  
  // إيقاف أي تسجيل جاري
  if (isRecording) {
    stopRecording();
  }
  
  // إعادة تحميل المحادثات
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
    
    // إضافة تاريخ إذا تغير
    if (messageDate !== lastDate) {
      var dateDiv = document.createElement("div");
      dateDiv.className = "date-divider";
      dateDiv.innerHTML = `<span>${formatDateHeader(msg.timestamp)}</span>`;
      container.appendChild(dateDiv);
      lastDate = messageDate;
    }
    
    showMessage({
      text: msg.content,
      media: msg.media_url,
      media_type: msg.media_type,
      timestamp: msg.timestamp,
      self: msg.is_from_me,
      sender_name: msg.sender_name,
      sender_id: msg.sender_id
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
    var options = { day: 'numeric', month: 'long' };
    return date.toLocaleDateString('ar-SA', options);
  }
}

// عرض رسالة
function showMessage(data, isSelf) {
  var container = document.getElementById("messages-container");
  var div = document.createElement("div");
  div.className = "message" + (isSelf ? " outgoing" : " incoming");
  
  var time = formatTime(data.timestamp);
  var content = "";
  
  // اسم المرسل (للمجموعات)
  if (data.sender_name && !isSelf && data.sender_name !== "أنا") {
    // استخراج الرقم من المعرف
    var senderNumber = data.sender_id ? 
      data.sender_id.replace('@c.us', '')
                   .replace('@lid', '')
                   .replace('@g.us', '')
                   .replace('@s.whatsapp.net', '') : 
      "";
    
    var displayName = data.sender_name;
    if (senderNumber && data.sender_name !== senderNumber) {
      displayName = `${data.sender_name}<br><small>${senderNumber}</small>`;
    }
    
    content += '<div class="sender-name">' + displayName + '</div>';
  }
  
  // الوسائط
  if (data.media) {
    if (data.media_type === 'image') {
      content += '<div class="message-media"><img src="' + data.media + '" onclick="viewImage(\'' + data.media + '\')" loading="lazy" alt="صورة"></div>';
    } else if (data.media_type === 'audio') {
      content += '<div class="message-audio"><audio controls preload="none"><source src="' + data.media + '" type="audio/ogg"></audio></div>';
    } else if (data.media_type === 'video') {
      content += '<div class="message-video"><video controls><source src="' + data.media + '"></video></div>';
    } else if (data.media_type === 'document') {
      content += '<div class="message-document"><a href="' + data.media + '" download><i class="fas fa-file"></i> ملف مرفق</a></div>';
    }
  }
  
  // النص
  if (data.text && data.text !== '[وسائط]') {
    content += '<div class="message-text">' + data.text + '</div>';
  }
  
  // الوقت والحالة
  content += '<div class="message-meta">';
  content += '<div class="message-time">' + time + '</div>';
  if (isSelf) {
    content += '<div class="message-status">✓✓</div>';
  }
  content += '</div>';
  
  div.innerHTML = content;
  container.appendChild(div);
}

// إرسال رسالة
function sendMessage() {
  var input = document.getElementById("message-input");
  var text = input.value.trim();
  
  if (!text || !currentChat) {
    showNotification("اكتب رسالة أولاً", "warning");
    return;
  }
  
  // إضافة رسالة مؤقتة
  var tempMessage = {
    text: text,
    timestamp: new Date().toISOString(),
    self: true,
    sender_name: "أنا"
  };
  
  showMessage(tempMessage, true);
  scrollToBottom();
  
  // إرسال الرسالة عبر السوكيت
  socket.emit("send_message", {
    to: currentChat,
    text: text
  });
  
  // مسح حقل الإدخال
  input.value = "";
  input.focus();
  
  // تشغيل صوت الإرسال
  playSendSound();
}

// إرسال رسالة صوتية
function sendVoiceMessage(filePath) {
  if (!currentChat) {
    showNotification("اختر محادثة أولاً", "warning");
    return;
  }
  
  socket.emit("send_media", {
    to: currentChat,
    filePath: filePath,
    mediaType: 'audio',
    caption: 'رسالة صوتية 🎤'
  });
  
  showNotification("تم إرسال الرسالة الصوتية", "success");
}

// بدء تسجيل صوتي - إصلاح المشكلة
function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showNotification("المتصفح لا يدعم التسجيل الصوتي", "error");
    return;
  }
  
  if (!currentChat) {
    showNotification("اختر محادثة أولاً", "warning");
    return;
  }
  
  // طلب إذن الميكروفون
  navigator.mediaDevices.getUserMedia({ 
    audio: true
  })
    .then(function(stream) {
      isRecording = true;
      audioChunks = [];
      
      // استخدم MIME type مدعوم
      const options = { mimeType: 'audio/webm' };
      if (!MediaRecorder.isTypeSupported('audio/webm')) {
        options.mimeType = 'audio/ogg; codecs=opus';
      }
      
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
        var audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        var reader = new FileReader();
        
        reader.onloadend = function() {
          var base64data = reader.result;
          var fileName = 'voice_' + Date.now() + '.ogg';
          
          // حفظ الرسالة الصوتية
          socket.emit("save_voice_message", {
            chatId: currentChat,
            audioData: base64data,
            fileName: fileName
          });
        };
        
        reader.readAsDataURL(audioBlob);
        
        // إيقاف الميكروفون
        stream.getTracks().forEach(track => track.stop());
      };
      
      // بدء التسجيل
      mediaRecorder.start();
      recordingStartTime = Date.now();
      
      // تحديث واجهة التسجيل
      document.getElementById("recording-area").style.display = "block";
      document.getElementById("message-input-area").style.display = "none";
      
      // تحديث زر التسجيل
      document.getElementById("record-btn").innerHTML = '<i class="fas fa-stop"></i>';
      document.getElementById("record-btn").onclick = stopRecording;
      
      // بدء المؤقت
      updateRecordingTimer();
      recordingTimer = setInterval(updateRecordingTimer, 1000);
      
      // تشغيل المؤثرات البصرية
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
  
  // إيقاف المؤقت والمؤثرات
  clearInterval(recordingTimer);
  stopVisualizer();
  
  // إعادة عرض واجهة الإدخال
  document.getElementById("recording-area").style.display = "none";
  document.getElementById("message-input-area").style.display = "flex";
  
  // استعادة زر التسجيل
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
  
  // إيقاف المؤقت والمؤثرات
  clearInterval(recordingTimer);
  stopVisualizer();
  
  // إعادة عرض واجهة الإدخال
  document.getElementById("recording-area").style.display = "none";
  document.getElementById("message-input-area").style.display = "flex";
  
  // استعادة زر التسجيل
  document.getElementById("record-btn").innerHTML = '<i class="fas fa-microphone"></i>';
  document.getElementById("record-btn").onclick = startRecording;
  
  showNotification("تم إلغاء التسجيل", "info");
}

// التبديل بين التسجيل والإدخال
function toggleRecord() {
  if (!currentChat) {
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
  
  // إيقاف التسجيل تلقائياً بعد 2 دقيقة
  if (minutes >= 2) {
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
  
  // تنظيف الرقم
  phoneNumber = phoneNumber.replace(/\D/g, '');
  
  if (phoneNumber.length < 10) {
    showNotification("رقم الهاتف غير صالح", "error");
    phoneInput.focus();
    return;
  }
  
  // إضافة رمز الدولي لمصر إذا لم يكن موجوداً
  if (phoneNumber.length === 10 && !phoneNumber.startsWith('2')) {
    phoneNumber = '2' + phoneNumber;
  }
  
  // إرسال طلب بدء محادثة
  socket.emit("start_new_chat", phoneNumber);
  
  // إغلاق النافذة
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

// إرسال صورة
function attachImage() {
  if (!currentChat) {
    showNotification("اختر محادثة أولاً", "warning");
    return;
  }
  
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'camera';
  
  input.onchange = function(e) {
    var file = e.target.files[0];
    if (!file) return;
    
    // التحقق من حجم الملف (10MB كحد أقصى)
    if (file.size > 10 * 1024 * 1024) {
      showNotification("حجم الصورة كبير جداً (10MB كحد أقصى)", "error");
      return;
    }
    
    var formData = new FormData();
    formData.append('file', file);
    
    showNotification("جارٍ رفع الصورة...", "info");
    
    fetch('/upload', {
      method: 'POST',
      body: formData
    })
    .then(function(response) { return response.json(); })
    .then(function(result) {
      if (result.success) {
        socket.emit("send_media", {
          to: currentChat,
          filePath: result.filePath,
          mediaType: 'image',
          caption: ''
        });
        showNotification("تم إرسال الصورة", "success");
      } else {
        showNotification("فشل رفع الصورة", "error");
      }
    })
    .catch(function(error) {
      console.error('فشل رفع الصورة:', error);
      showNotification("فشل إرسال الصورة", "error");
    });
  };
  
  input.click();
}

// عرض صورة
function viewImage(src) {
  window.open(src, '_blank');
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
  if (confirm("هل تريد تسجيل الخروج من واتساب؟")) {
    socket.emit("logout");
    showNotification("جارٍ تسجيل الخروج...", "info");
  }
}

// عند تحميل الصفحة
window.onload = function() {
  console.log("📱 التطبيق جاهز للهواتف القديمة والزرارية");
  
  // إعداد حقل الإدخال
  var input = document.getElementById("message-input");
  if (input) {
    input.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        sendMessage();
        e.preventDefault();
      }
    });
  }
  
  // إضافة زر تسجيل الخروج
  var chatsActions = document.querySelector('.chats-actions');
  if (chatsActions) {
    var logoutBtn = document.createElement('button');
    logoutBtn.className = 'chats-icon-btn';
    logoutBtn.title = 'تسجيل الخروج';
    logoutBtn.innerHTML = '<i class="fas fa-sign-out-alt"></i>';
    logoutBtn.onclick = logout;
    chatsActions.appendChild(logoutBtn);
  }
  
  // إظهار شاشة الانتظار
  showScreen("login");
};
