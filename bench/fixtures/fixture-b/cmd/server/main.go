package main

import (
	"log"
	"net/http"
	"os"

	"api-gateway/internal/auth"
	"api-gateway/internal/handler"
	"api-gateway/internal/middleware"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	jwtValidator := auth.NewValidator(os.Getenv("JWT_SECRET"))
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)

	chain := middleware.Chain(
		middleware.Logger,
		middleware.CORS,
		jwtValidator.Middleware,
	)

	log.Printf("Starting gateway on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, chain(mux)))
}
