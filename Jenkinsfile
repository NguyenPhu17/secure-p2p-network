pipeline {
    agent any

    environment {
        // Tên định danh Credentials trên Jenkins (Manage Jenkins -> Credentials)
        DOCKER_HUB_CRED = 'dockerhub-credentials'
        DOCKER_USER = 'nguyenphu17'

        BACKEND_IMAGE = "${DOCKER_USER}/secure-p2p-backend"
        UI_IMAGE = "${DOCKER_USER}/secure-p2p-ui"
        BUILD_TAG = "${env.BUILD_NUMBER}"
        CI_PG_CONTAINER = "p2p-ci-pg-${env.BUILD_NUMBER}"
        CI_PG_PORT = '5439'
    }

    stages {
        stage('1. Checkout SCM') {
            steps {
                echo "🚀 [CI/CD] Kéo mã nguồn mới nhất từ Git..."
                checkout scm
            }
        }

        stage('2. Install Dependencies') {
            steps {
                echo "📦 [CI/CD] Cài đặt dependencies chuẩn lockfile (npm ci)..."
                sh 'npm ci'
                sh 'cd ui && npm ci'
            }
        }

        stage('3. Typecheck, Build & Compose Validate') {
            steps {
                echo "🔍 [CI/CD] Kiểm tra TypeScript, biên dịch Backend/UI và validate Docker Compose..."
                sh 'npx tsc --noEmit'
                sh 'npm run build'
                sh 'cd ui && npm run build'
                sh 'DB_PASSWORD=ci_validate_only JWT_SECRET=ci_validate_only docker compose config --quiet'
            }
        }

        stage('4. Security Dependency Audit') {
            steps {
                echo "🛡️ [CI/CD] Kiểm tra lỗ hổng thư viện sản phẩm (npm audit)..."
                sh 'npm audit --omit=dev --audit-level=high'
                sh 'cd ui && npm audit --omit=dev --audit-level=high'
            }
        }

        stage('5. Run Automated Tests') {
            steps {
                echo "🧪 [CI/CD] Chạy Unit Test Kademlia DHT..."
                sh 'npm run test:dht:unit'

                echo "🐘 [CI/CD] Khởi tạo PostgreSQL tạm thời cho Security Integration Tests..."
                sh """
                    docker rm -f ${CI_PG_CONTAINER} >/dev/null 2>&1 || true
                    docker run -d --name ${CI_PG_CONTAINER} \
                      -e POSTGRES_DB=p2p_network \
                      -e POSTGRES_USER=postgres \
                      -e POSTGRES_PASSWORD=ci_test_password \
                      -p 127.0.0.1:${CI_PG_PORT}:5432 \
                      postgres:15-alpine
                """
                sh """
                    for i in \$(seq 1 20); do
                      if docker exec ${CI_PG_CONTAINER} pg_isready -U postgres -d p2p_network >/dev/null 2>&1; then
                        exit 0
                      fi
                      sleep 1
                    done
                    echo "❌ PostgreSQL CI container không sẵn sàng!"
                    exit 1
                """
                script {
                    def pgHost = '127.0.0.1'
                    def pgPort = "${CI_PG_PORT}"
                    def reachable = sh(
                        script: "node -e \"const net=require('net');const s=net.connect(${CI_PG_PORT},'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),2000)\"",
                        returnStatus: true
                    ) == 0
                    if (!reachable) {
                        pgHost = sh(
                            script: "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${CI_PG_CONTAINER}",
                            returnStdout: true
                        ).trim()
                        pgPort = '5432'
                    }
                    def ciJwtSecret = sh(
                        script: "node -e \"process.stdout.write(require('crypto').randomBytes(32).toString('hex'))\"",
                        returnStdout: true
                    ).trim()
                    withEnv([
                        "DB_HOST=${pgHost}",
                        "DB_PORT=${pgPort}",
                        "DB_NAME=p2p_network",
                        "DB_USER=postgres",
                        "DB_PASSWORD=ci_test_password",
                        "JWT_SECRET=${ciJwtSecret}"
                    ]) {
                        sh 'npm run test:security'
                    }
                }
            }
        }

        stage('6. Build Docker Images & Scan') {
            steps {
                echo "🐳 [CI/CD] Đóng gói Docker Images (Multi-stage, non-root)..."
                sh "docker build -t ${BACKEND_IMAGE}:${BUILD_TAG} -t ${BACKEND_IMAGE}:latest -f Dockerfile ."
                sh "docker build -t ${UI_IMAGE}:${BUILD_TAG} -t ${UI_IMAGE}:latest -f ui/Dockerfile ui"

                sh """
                    if command -v trivy >/dev/null 2>&1; then
                      trivy image --exit-code 1 --severity CRITICAL,HIGH --ignore-unfixed ${BACKEND_IMAGE}:${BUILD_TAG}
                      trivy image --exit-code 1 --severity CRITICAL,HIGH --ignore-unfixed ${UI_IMAGE}:${BUILD_TAG}
                    else
                      echo "ℹ️ Trivy chưa được cài trên Jenkins agent, bỏ qua bước quét image."
                    fi
                """
            }
        }

        stage('7. Push to Docker Hub') {
            when {
                expression { return !env.BRANCH_NAME || env.BRANCH_NAME == 'main' }
            }
            steps {
                script {
                    echo "☁️ [CI/CD] Đẩy Images lên Docker Hub..."
                    withCredentials([usernamePassword(credentialsId: "${DOCKER_HUB_CRED}", usernameVariable: 'DH_USER', passwordVariable: 'DH_PASS')]) {
                        sh 'echo "$DH_PASS" | docker login -u "$DH_USER" --password-stdin'
                        sh "docker push ${BACKEND_IMAGE}:${BUILD_TAG}"
                        sh "docker push ${BACKEND_IMAGE}:latest"
                        sh "docker push ${UI_IMAGE}:${BUILD_TAG}"
                        sh "docker push ${UI_IMAGE}:latest"
                    }
                }
            }
        }

        stage('8. CD - Pull-based Deploy & Health Verify') {
            when {
                allOf {
                    expression { return !env.BRANCH_NAME || env.BRANCH_NAME == 'main' }
                    expression { return env.ENABLE_DEPLOY == 'true' }
                }
            }
            steps {
                echo "🎯 [CD] Triển khai pull-based tới Server bằng tag ${BUILD_TAG}..."
                sh """
                    BACKEND_IMAGE=${BACKEND_IMAGE} UI_IMAGE=${UI_IMAGE} IMAGE_TAG=${BUILD_TAG} docker compose pull manager ui
                    BACKEND_IMAGE=${BACKEND_IMAGE} UI_IMAGE=${UI_IMAGE} IMAGE_TAG=${BUILD_TAG} docker compose up -d --no-build --wait
                """
            }
        }
    }

    post {
        always {
            echo "🧹 [CI/CD] Dọn dẹp container test tạm và image dư thừa..."
            sh "docker rm -f ${CI_PG_CONTAINER} >/dev/null 2>&1 || true"
            sh 'docker image prune -f || true'
        }
        success {
            echo "✅ PIPELINE CI/CD THÀNH CÔNG TRÊN BUILD #${env.BUILD_NUMBER}!"
        }
        failure {
            echo "❌ [CI/CD] PIPELINE THẤT BẠI! Kiểm tra log lỗi ở trên."
        }
    }
}
