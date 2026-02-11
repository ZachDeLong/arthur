package auth

import (
	"net/http"
	"strings"
)

type Validator struct {
	secret string
}

func NewValidator(secret string) *Validator {
	return &Validator{secret: secret}
}

func (v *Validator) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		// Token validation placeholder
		next.ServeHTTP(w, r)
	})
}
