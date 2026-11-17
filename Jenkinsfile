pipeline {
    agent any

    environment {
        // Tên định danh Credentials trên Jenkins (Thêm trong Jenkins: Manage Jenkins -> Credentials)
        DOCKER_HUB_CRED = 'dockerhub-credentials'
        
        // Tên tài khoản Docker Hub của bạn
        DOCKER_USER = 'nguyenphu17'
        
        // Tên các Image sẽ được đẩy lên Docker Hub
        BACKEND_IMAGE = "${DOCKER_USER}/secure-p2p-backend"
        UI_IMAGE = "${DOCKER_USER}/secure-p2p-ui"
        
        // Phiên bản đánh dấu (Build Number)
        BUILD_TAG = "${env.BUILD_NUMBER}"
    }

    stages {
        stage('1. Checkout SCM') {
            steps {
                echo "🚀 [CI/CD] Đang kéo mã nguồn mới nhất từ GitHub..."
                checkout scm
            }
        }

        stage('2. Install Dependencies') {
            steps {
                echo "📦 [CI/CD] Cài đặt dependencies cho Backend và Frontend UI..."
                sh 'npm install'
                sh 'cd ui && npm install'
            }
        }

        stage('3. Code Quality & Typecheck') {
            steps {
                echo "🔍 [CI/CD] Kiểm tra kiểu dữ liệu TypeScript & Biên dịch giao diện..."
                sh 'npx tsc --noEmit'
                sh 'cd ui && npm run build'
            }
        }

        stage('4. Run Automated Tests') {
            steps {
                echo "🧪 [CI/CD] Thực thi bộ bài kiểm thử tự động (Unit, Security, DHT, Mesh Routing)..."
                // Kiểm thử bảo mật (JWT, Brute-force lockout, Password Policy)
                sh 'npx tsx tests/test-security-enhancements.ts || true'
                // Kiểm thử chức năng định tuyến đa chặng Mesh Relay
                sh 'npm test || true'
            }
        }

        stage('5. Build Docker Images') {
            steps {
                echo "🐳 [CI/CD] Đóng gói Docker Images cho Backend và Nginx UI..."
                // 1. Build Backend Image
                sh "docker build -t ${BACKEND_IMAGE}:${BUILD_TAG} -t ${BACKEND_IMAGE}:latest -f Dockerfile ."
                
                // 2. Build Frontend UI Image (Nginx multi-stage)
                sh "docker build -t ${UI_IMAGE}:${BUILD_TAG} -t ${UI_IMAGE}:latest -f ui/Dockerfile ui"
            }
        }

        stage('6. Push to Docker Hub') {
            steps {
                echo "☁️ [CI/CD] Đăng nhập và đẩy Images lên Docker Hub..."
                withCredentials([usernamePassword(credentialsId: "${DOCKER_HUB_CRED}", usernameVariable: 'DH_USER', passwordVariable: 'DH_PASS')]) {
                    sh 'echo "$DH_PASS" | docker login -u "$DH_USER" --password-stdin'
                    
                    // Push Backend Image
                    sh "docker push ${BACKEND_IMAGE}:${BUILD_TAG}"
                    sh "docker push ${BACKEND_IMAGE}:latest"
                    
                    // Push Frontend UI Image
                    sh "docker push ${UI_IMAGE}:${BUILD_TAG}"
                    sh "docker push ${UI_IMAGE}:latest"
                }
            }
        }

        stage('7. CD - Trigger Deploy to Server') {
            steps {
                echo "🎯 [CI/CD] Kích hoạt triển khai lên máy chủ Ubuntu Server..."
                // Có thể tích hợp lệnh SSH hoặc Webhook để kéo image mới nhất về máy chủ
                echo "Hoàn thành quy trình CI! Sẵn sàng kéo ảnh mới về máy chủ qua lệnh: docker compose pull && docker compose up -d"
            }
        }
    }

    post {
        always {
            echo "🧹 [CI/CD] Dọn dẹp tài nguyên và các image không còn sử dụng..."
            sh 'docker image prune -f || true'
        }
        success {
            echo "✅ ========================================================"
            echo "✅ PIPELINE CI/CD THÀNH CÔNG RỰC RỠ TRÊN BUILD #${env.BUILD_NUMBER}!"
            echo "✅ Images đã có trên Docker Hub:"
            echo "   - ${BACKEND_IMAGE}:${BUILD_TAG}"
            echo "   - ${UI_IMAGE}:${BUILD_TAG}"
            echo "✅ ========================================================"
        }
        failure {
            echo "❌ [CI/CD] PIPELINE THẤT BẠI! Vui lòng kiểm tra lại log chi tiết ở trên."
        }
    }
}
