// بدء تسجيل صوتي - محسّن بدون ffmpeg
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
      sampleRate: 16000, // 16kHz هو معدل واتساب القياسي
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })
  .then(function(stream) {
    isRecording = true;
    audioChunks = [];
    
    // استخدام تنسيقات مدعومة بواسطة المتصفح
    const mimeTypes = [
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
      'audio/webm',
      'audio/ogg'
    ];
    
    let mediaRecorderOptions = {};
    
    // اختبار التنسيقات المدعومة
    for (let mimeType of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        mediaRecorderOptions = { mimeType: mimeType };
        console.log("✅ تنسيق صوتي مدعوم:", mimeType);
        break;
      }
    }
    
    try {
      mediaRecorder = new MediaRecorder(stream, mediaRecorderOptions);
    } catch (e) {
      console.log("⚠️ لا يدعم تنسيقات متقدمة، استخدام الإعدادات الافتراضية:", e);
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
      
      // تحويل Blob إلى base64
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
            fileName: fileName,
            mimeType: mediaRecorder.mimeType || 'audio/webm'
          })
        })
        .then(response => response.json())
        .then(result => {
          if (result.success) {
            // إرسال الرسالة الصوتية
            socket.emit("send_media", {
              to: currentChat,
              filePath: result.filePath,
              mediaType: 'audio',
              isVoiceMessage: true,
              caption: 'رسالة صوتية 🎤'
            });
            showNotification("تم إرسال الرسالة الصوتية", "success");
          } else {
            showNotification("فشل حفظ الرسالة الصوتية", "error");
          }
        })
        .catch(error => {
          console.error('❌ خطأ في حفظ الرسالة الصوتية:', error);
          showNotification("فشل إرسال الرسالة الصوتية", "error");
        });
      };
      
      reader.readAsDataURL(audioBlob);
      
      // إيقاف جميع المسارات
      stream.getTracks().forEach(track => track.stop());
    };
    
    mediaRecorder.start(100); // جمع البيانات كل 100ms
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
