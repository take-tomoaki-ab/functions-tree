package main

type Server struct{ name string }

type Worker struct{}

func NewServer() *Server {
	return &Server{name: "srv"}
}

// Start は Worker にも同名メソッドがあるため、srv.Start() は曖昧で解決されない
func (s *Server) Start() {
	s.log("start")
}

func (s *Server) log(msg string) {
	_ = msg
}

func (w *Worker) Start() {}
